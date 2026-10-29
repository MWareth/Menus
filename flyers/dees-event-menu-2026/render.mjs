// node render.mjs  →  Dees-Dessert-Menu-A4.pdf and a PNG preview
import pkg from "/opt/node22/lib/node_modules/playwright/index.js";
import { fileURLToPath } from "url";
import path from "path";
const { chromium } = pkg;
const dir = path.dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 3 });
await p.goto("file://" + dir + "/menu.html"); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
await p.pdf({ path: dir + "/Dees-Dessert-Menu-A4.pdf", width: "210mm", height: "297mm", printBackground: true });
await p.locator(".page").screenshot({ path: dir + "/Dees-Dessert-Menu-A4.png" });
await b.close();
