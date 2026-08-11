import assert from "node:assert/strict";
import test from "node:test";

import { markdownPropsEqual } from "./markdownPropsEqual.ts";

const base = { content: "buzz://message?channel=c&id=m" };

test("identical content rerenders when generated previews become suppressed", () => {
  assert.equal(
    markdownPropsEqual(
      { ...base, linkPreviewsSuppressed: false },
      { ...base, linkPreviewsSuppressed: true },
    ),
    false,
  );
});

test("preview tags compare shallowly and invalidate on tag edits", () => {
  assert.equal(
    markdownPropsEqual(
      { ...base, linkPreviewTags: [["link-preview", "none"]] },
      { ...base, linkPreviewTags: [["link-preview", "none"]] },
    ),
    true,
  );
  assert.equal(
    markdownPropsEqual(
      { ...base, linkPreviewTags: [["link-preview", "snapshot", "old"]] },
      { ...base, linkPreviewTags: [["link-preview", "none"]] },
    ),
    false,
  );
});

test("message identity and removal callback invalidate memoized Markdown", () => {
  const remove = async () => {};
  assert.equal(
    markdownPropsEqual(
      { ...base, messageId: "old", onRemoveLinkPreviewsForEveryone: remove },
      { ...base, messageId: "new", onRemoveLinkPreviewsForEveryone: remove },
    ),
    false,
  );
  assert.equal(
    markdownPropsEqual(
      { ...base, messageId: "same", onRemoveLinkPreviewsForEveryone: remove },
      {
        ...base,
        messageId: "same",
        onRemoveLinkPreviewsForEveryone: async () => {},
      },
    ),
    false,
  );
});
