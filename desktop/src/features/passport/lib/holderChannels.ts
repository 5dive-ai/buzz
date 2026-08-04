/**
 * Channel membership resolution for a passport holder, shared by the passport
 * screen and the agent-badge hook. Membership is derived from the viewer's
 * own channel list, so private rooms only ever appear to viewers already in
 * them; relay agents additionally declare their working channels.
 */

export type HolderChannelLink = { id: string; name: string };

export function resolveHolderChannels(
  channels:
    | readonly {
        channelType: string;
        id: string;
        memberPubkeys: readonly string[];
        name: string;
      }[]
    | undefined,
  relayAgent:
    | { channelIds: readonly string[]; channels: readonly string[] }
    | undefined,
  pubkeyLower: string | null,
): HolderChannelLink[] {
  const links = new Map<string, HolderChannelLink>();
  relayAgent?.channels.forEach((name, index) => {
    const id = relayAgent.channelIds[index] ?? name;
    links.set(id, { id, name });
  });
  for (const channel of channels ?? []) {
    if (channel.channelType === "dm") {
      continue;
    }
    const isMember = channel.memberPubkeys.some(
      (memberPubkey) => memberPubkey.toLowerCase() === pubkeyLower,
    );
    if (isMember) {
      links.set(channel.id, { id: channel.id, name: channel.name });
    }
  }
  return [...links.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
