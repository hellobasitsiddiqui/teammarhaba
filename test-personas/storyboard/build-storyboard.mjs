// Storyboard compositor (TM-636 / TM-628) — proof of the "2×4 phone wall".
//
// Shoots 8 real product screens at a phone viewport, one per persona/step, then tiles them into a
// single 2-rows × 4-cols grid ("everyone's screen at the same step") and screenshots THAT into one
// attachable proof PNG. Screens are the committed design-kit `paper` wireframes (render fully offline,
// phone-shaped) — a lightweight stand-in until the live multi-context journey (TM-528) drives them.
//
// Run: node build-storyboard.mjs   (needs `playwright` + chromium installed in this dir)

import { chromium, devices } from "playwright";
import fs from "node:fs";
import path from "node:path";

const KIT = "/tmp/agent-C-wt-storyboard/design-kit/pages";
const OUT = "/tmp/agent-C-wt-storyboard/test-personas/storyboard";
const PANELS_DIR = path.join(OUT, "panels");
fs.mkdirSync(PANELS_DIR, { recursive: true });

// One step of Story 01 (Willen Lake Walk): everyone's screen at the same moment.
const PANELS = [
  { persona: "Joe · 18 · free", caption: "Event detail — on the waitlist", slug: "paper-event-detail" },
  { persona: "Sarah · member", caption: "RSVP confirmed — you're going", slug: "paper-rsvp-confirmed" },
  { persona: "Marcus · 45", caption: "My events — promoted off waitlist", slug: "paper-my-events" },
  { persona: "Priya · premium", caption: "Browsing the events feed", slug: "paper-events-list" },
  { persona: "Group chat", caption: "Event thread — 'see you at the boathouse'", slug: "paper-chat-thread" },
  { persona: "Everyone", caption: "Notifications — the confirmations", slug: "paper-notifications" },
  { persona: "Aisha · admin", caption: "Event roster — eyeballing attendance", slug: "paper-admin-events" },
  { persona: "On the day", caption: "GPS check-in at the lake", slug: "paper-gps-attendance" },
];

const phone = devices["iPhone 13"];

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...phone });
for (const [i, p] of PANELS.entries()) {
  const page = await ctx.newPage();
  const url = "file://" + path.join(KIT, p.slug, "index.html");
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
  } catch {
    await page.goto(url, { waitUntil: "load", timeout: 20000 });
  }
  await page.waitForTimeout(700); // let fonts + doodle decor settle
  await page.screenshot({ path: path.join(PANELS_DIR, `panel-${i + 1}.png`) });
  await page.close();
  console.log("shot", i + 1, p.slug);
}
await browser.close();

// Build the 2×4 grid page (4 columns → 8 panels = 2 rows).
const cells = PANELS.map(
  (p, i) => `
    <figure class="cell">
      <div class="phone"><img src="panels/panel-${i + 1}.png" alt="${p.persona}"></div>
      <figcaption><b>${p.persona}</b><span>${p.caption}</span></figcaption>
    </figure>`,
).join("");

const grid = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Patrick+Hand&family=Nunito:wght@400;700&display=swap" rel="stylesheet">
<style>
  body{margin:0;background:#fbf6ec;font-family:Nunito,system-ui,sans-serif;
       background-image:radial-gradient(#e3d8c4 1px,transparent 1px);background-size:22px 22px}
  .wrap{padding:30px 34px}
  h1{font-family:'Patrick Hand',cursive;margin:0 0 2px;font-size:32px;color:#2b2b2b}
  .sub{color:#6b6257;margin:0 0 22px;font-size:15px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px}
  .cell{margin:0;text-align:center}
  .phone{background:#111;border-radius:28px;padding:9px;box-shadow:5px 7px 0 rgba(0,0,0,.12)}
  .phone img{display:block;width:100%;border-radius:20px}
  figcaption{margin-top:9px;font-size:13px;line-height:1.3}
  figcaption b{display:block;color:#2b2b2b}
  figcaption span{color:#6b6257}
</style></head>
<body><div class="wrap">
  <h1>Story 01 — Willen Lake Walk · lockstep phone wall</h1>
  <p class="sub">Every persona's screen at the same step (2×4). Proof of the storyboard compositor — TM-636 / TM-628. Screens are the design-kit paper wireframes; the live multi-context journey lands with TM-528.</p>
  <div class="grid">${cells}</div>
</div></body></html>`;
fs.writeFileSync(path.join(OUT, "index.html"), grid);

// Screenshot the grid page → one attachable proof PNG.
const b2 = await chromium.launch();
const ctx2 = await b2.newContext({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 2 });
const p2 = await ctx2.newPage();
await p2.goto("file://" + path.join(OUT, "index.html"), { waitUntil: "networkidle", timeout: 20000 });
await p2.waitForTimeout(900);
await p2.screenshot({ path: path.join(OUT, "storyboard-grid.png"), fullPage: true });
await b2.close();
console.log("DONE -> storyboard-grid.png");
