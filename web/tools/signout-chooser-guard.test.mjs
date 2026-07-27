// TM-1097 — the Sign out button opens a CHOOSER ("Sign out on this device" vs "Sign out everywhere")
// instead of going straight to a this-device confirm, so the everywhere option is no longer buried in
// the Security section. Source-guard over the profile.js wiring + the chooser CSS (the DOM flow itself
// is api/Firebase-coupled and so is behaviourally covered by tm906-signout-confirm.spec.mjs e2e).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const profileJs = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");
const css = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");
const chooserBlock = (css.match(/\.tm-signout-chooser\s*\{[^}]*\}/s) || [""])[0];
const choiceBlock = (css.match(/\.tm-signout-choice\s*\{[^}]*\}/s) || [""])[0];

test("TM-1097: profile imports the signOutEverywhere API", () => {
  // The everywhere path reuses the SAME api.js primitive the Security block does — no new endpoint.
  assert.match(profileJs, /\bsignOutEverywhere\b[\s\S]*from "\.\/api\.js"/, "signOutEverywhere imported from api.js");
});

test("TM-1097: the Sign out row opens a chooser modal with both options + cancel", () => {
  // doSignOut builds a modal("Sign out", ...) — a chooser, not a bare confirmDialog.
  assert.match(profileJs, /modal\(\s*"Sign out"/, "doSignOut opens a modal-based chooser");
  assert.match(profileJs, /id:\s*"signout-this-device"/, "has the this-device option");
  assert.match(profileJs, /id:\s*"signout-everywhere"/, "has the everywhere option");
  assert.match(profileJs, /id:\s*"signout-cancel"/, "has an explicit cancel");
  assert.match(profileJs, /class:\s*"tm-signout-chooser"/, "chooser body carries the guarded class");
});

test("TM-1097: this-device signs out this session; everywhere confirms then revokes-all then clears the tab", () => {
  // this-device path = the pre-TM-1097 behaviour (Firebase signOut only).
  assert.match(profileJs, /function signOutThisDevice\(\)[\s\S]*?await signOut\(\)/, "this-device calls signOut()");
  // everywhere path = destructive confirm → signOutEverywhere() → local signOut(), mirroring Security.
  const flow = (profileJs.match(/function signOutEverywhereFlow\(\)[\s\S]*?\n\}/) || [""])[0];
  assert.match(flow, /confirmDialog\(/, "everywhere gates behind a confirm");
  assert.match(flow, /Sign out everywhere\?/, "everywhere confirm uses the everywhere title");
  assert.match(flow, /await signOutEverywhere\(\)/, "everywhere revokes all sessions");
  assert.match(flow, /await signOut\(\)/, "everywhere then clears this tab");
  // The two options are wired to their flows.
  assert.match(profileJs, /signout-this-device[\s\S]*?signOutThisDevice\(\)/, "this-device button → signOutThisDevice");
  assert.match(profileJs, /signout-everywhere[\s\S]*?signOutEverywhereFlow\(\)/, "everywhere button → signOutEverywhereFlow");
});

test("TM-1097: the chooser buttons stack full-width (action-sheet idiom)", () => {
  assert.ok(chooserBlock, ".tm-signout-chooser rule must exist");
  assert.match(chooserBlock, /flex-direction:\s*column/, "options stack vertically");
  assert.ok(choiceBlock, ".tm-signout-choice rule must exist");
  assert.match(choiceBlock, /width:\s*100%/, "each option is full-width");
});
