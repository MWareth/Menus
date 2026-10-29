// node render-genz.mjs  →  the loud Slate Card set: a PNG of each piece (3x) and print PDFs
import pkg from "/opt/node22/lib/node_modules/playwright/index.js";
import { fileURLToPath } from "url";
import path from "path";
const { chromium } = pkg;
const dir = path.dirname(fileURLToPath(import.meta.url));
const views = { counter: [148, 210, "Slate-Card-loud-counter-sign-A5"], table: [96, 136, "Slate-Card-loud-table-card"], hand: [85, 55, "Slate-Card-loud-handout"],
  "counter-sheet": [210, 297, "Slate-Card-loud-counter-sign-on-A4"], "table-sheet": [210, 297, "Slate-Card-loud-table-cards-4-per-A4"], "hand-sheet": [210, 297, "Slate-Card-loud-handouts-8-per-A4"] };
const b = await chromium.launch();
for (const [v, [w, h, name]] of Object.entries(views)) {
  const p = await b.newPage({ viewport: { width: Math.ceil(w * 3.78), height: Math.ceil(h * 3.78) }, deviceScaleFactor: 3.2 });
  await p.goto("file://" + dir + "/genz.html#" + v); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
  await p.pdf({ path: dir + "/" + name + ".pdf", width: w + "mm", height: h + "mm", printBackground: true });
  await p.locator("#out > div").screenshot({ path: dir + "/" + name + ".png" });
  await p.close();
}
await b.close();
