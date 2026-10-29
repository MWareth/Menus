// node render.mjs  →  PDFs to print and PNG previews of every piece
import pkg from "/opt/node22/lib/node_modules/playwright/index.js";
const { chromium } = pkg;
import { fileURLToPath } from "url";
import path from "path";
const dir = path.dirname(fileURLToPath(import.meta.url));
const views = { counter: [148, 210, "Slate-Card-counter-sign-A5"], table: [96, 136, "Slate-Card-table-card"],
  hand: [85, 55, "Slate-Card-handout"], "table-sheet": [210, 297, "Slate-Card-table-cards-4-per-A4"], "hand-sheet": [210, 297, "Slate-Card-handouts-8-per-A4"] };
const b = await chromium.launch();
for (const [v, [w, h, name]] of Object.entries(views)) {
  const p = await b.newPage({ viewport: { width: Math.ceil(w * 3.78), height: Math.ceil(h * 3.78) }, deviceScaleFactor: 3 });
  await p.goto("file://" + dir + "/print.html#" + v); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
  await p.pdf({ path: dir + "/" + name + ".pdf", width: w + "mm", height: h + "mm", printBackground: true });
  if (!v.endsWith("sheet")) await p.locator("#out > div").screenshot({ path: dir + "/" + name + ".png" });
  await p.close();
}
await b.close();
