// Guard: locking the chat composer also disables the per-message reply/react affordances (TM-727).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// When a send fails "locked" (the caller was muted/removed, or the thread closed), chat.js replaces the
// live composer with a disabled state (lockComposer). But the per-message "Reply" button and the "react"
// affordance render gated on `thread.canCompose`; if lockComposer doesn't also flip that false, they keep
// rendering after the composer is gone — a "Reply" tap runs beginReply → paintReplyPreview against a
// detached composer, a silent dead-end. chat.js can't be imported in Node (a transitive `https:` Firebase
// import in the api/auth chain isn't resolvable by the default ESM loader), so — like
// events-map-link-a11y.test.mjs / events-aria-describedby.test.mjs — this is a source-level guard that
// pins the invariant: lockComposer must clear `thread.canCompose`, and the reply/react gates must read it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/chat.js"), "utf8");

// The body of the lockComposer function (up to the next top-level `function `).
function lockComposerBody(src) {
  const start = src.indexOf("function lockComposer(");
  assert.ok(start >= 0, "lockComposer is defined");
  const after = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

test("lockComposer flips thread.canCompose false so dead-end affordances stop rendering", () => {
  const body = lockComposerBody(SRC);
  assert.match(
    body,
    /thread\.canCompose\s*=\s*false/,
    "lockComposer must set thread.canCompose = false (else reply/react buttons keep targeting the locked composer)",
  );
  // A reply-in-progress targets the composer that's now gone — it must be abandoned too.
  assert.match(body, /thread\.replyTo\s*=\s*null/, "lockComposer must drop any in-progress reply target");
});

test("the reply + react affordances are gated on thread.canCompose (the flag lockComposer clears)", () => {
  // These are the affordances the lock must suppress — assert they read the same flag, so clearing it in
  // lockComposer genuinely removes them on the next repaint (guards against the gate being renamed away).
  assert.match(
    SRC,
    /reactionBar\([\s\S]*?thread\.canCompose\)/,
    "the react affordance is gated on thread.canCompose",
  );
  assert.match(
    SRC,
    /if\s*\(!m\.pending\s*&&\s*m\.id\s*&&\s*thread\.canCompose\)/,
    "the reply affordance is gated on thread.canCompose",
  );
});
