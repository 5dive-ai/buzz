# Hand-testing `buzz-agent-core`

The premise: this binary **is** `buzz-agent`. Same name, same ACP contract,
goose underneath. So hand-testing is a *swap*, not a new setup — you run the
normal buzz-acp flow and repoint one environment variable.

`buzz-acp` derives harness identity from the command's **basename**
(`normalize_agent_command_identity`, `buzz-acp/src/config.rs:600-615`) and
already has a `"buzz-agent"` arm meaning "no extra args"
(`default_agent_args`, `:617-624`). The binary is emitted as `buzz-agent`
precisely so buzz-acp cannot tell the difference.

## 0. Build

```bash
. ./bin/activate-hermit
cargo build --release -p buzz-acp -p buzz-dev-mcp -p buzz-cli
cargo build --release --manifest-path buzz-agent-core/Cargo.toml
```

Takes a few minutes the first time (goose pulls ~700 crates into its own
lockfile).

## 1. The swap

```bash
just relay                      # terminal 1

# terminal 2
just agent-core                 # new: goose-backed buzz-agent
just goose                      # old: for A/B comparison
```

`just agent-core` is `just goose` with two lines changed:

```diff
- BUZZ_ACP_AGENT_COMMAND=goose
- BUZZ_ACP_AGENT_ARGS=acp
+ BUZZ_ACP_AGENT_COMMAND=<repo>/buzz-agent-core/target/release/buzz-agent
+ BUZZ_ACP_MCP_COMMAND=<repo>/target/release/buzz-dev-mcp
```

Everything else — relay URL, keys, agent count, heartbeat — is identical.

## 2. What to actually check

Ordered by how likely it is to be broken and how badly it would matter.
The automated suite covers each of these at the stdio layer; this is about
the parts only a human can see.

### A. Persona actually arrives — the whole reason for embedding

```
@fizz who are you?
```

Should answer *as Fizz*, and should know the `buzz` CLI exists. If it answers
as generic goose, `systemPrompt` was dropped — the exact failure that makes
plain-ACP embedding impossible (goose's own ACP server never reads
`systemPrompt`; both PRs that would have wired it, buzz#1290 and goose#9971,
are closed unmerged).

### B. `_Stop` veto — buzz-agent's most load-bearing behaviour

```
@fizz make a todo list with 3 items, then stop immediately without doing them
```

It must **refuse to stop** while items are open, and keep working. Capped at 3
vetoes, so it will eventually end regardless. Watch for
`_Stop hook vetoed end of turn` in the buzz-acp log.

### C. Streaming feel

buzz-agent emitted one chunk per round; goose streams token-by-token. The
automated tests prove the relay isn't write-amplified (chunks are coalesced by
identity key, flushed at 500ms, paced at 167ms/90-per-minute), but **only a
human can tell you whether it feels better or worse in the desktop app.**
This is the single most likely source of "something feels off".

### D. Cancel mid-tool

Ask for something long (`count slowly to 100 with a shell sleep`), then hit
stop. Check: the turn ends promptly, and **no tool call is left spinning** in
the UI. Cancellation is a cooperative drain (5s budget) — dropping the stream
instead leaves the MCP child running and the spinner stuck forever. That bug
existed and is fixed; this is the visual confirmation.

### E. Steering

Send a second message while the agent is working. It should be absorbed into
the running turn, *not* cancel-and-restart it. If the desktop visibly restarts
the turn, `activeRunId` is at the wrong nesting depth — it must be at
`params.update._meta.goose.activeRunId`, with `_meta` **inside** `update`
(`buzz-acp/src/acp.rs:1607-1613`). Wrong depth degrades silently to
cancel+re-prompt with no error anywhere.

### F. Model picker

Open the model picker in the desktop app. It should list models, not just the
current one. Absent catalog is degraded UX, never a session failure.

### G. Tool hygiene — known deviation

The model can now *see* `_Stop` and `_PostCompact` (goose's allowlist gates
advertising and dispatch together, so hiding them would break the veto). A
system-prompt extension tells it not to call them. Watch for the agent calling
`_Stop` on its own — if that happens, the guidance text needs strengthening.

## 3. A/B against the old agent

The old binary still exists, so run both against the same relay and compare:

```bash
just goose                                        # old, terminal 2
just agent-core                                   # new, terminal 3
```

Two agents, two identities, same channel. Ask both the same thing.

## 4. Known not-done

* Never run against a **real** provider — all automated coverage uses a fake
  SSE server. Databricks OAuth in particular is entirely goose's code path now
  and completely unexercised.
* Never run inside the **desktop app** — only via buzz-acp on the CLI.
* `buzz-agent` (old) is not deleted, nothing is wired into packaging or the
  harness catalog.
* Binary is +22.7 MiB raw / +6.0 MiB gzip vs the old one.
