// node stickers/render.mjs <name>  ->  <name>.pdf + <name>-sheet.png (first page)
import pkg from "/opt/node22/lib/node_modules/playwright/index.js";
const { chromium } = pkg;
const name = process.argv[2] || "Dees-Smash-stickers";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2.5 });
await p.goto("file://" + process.cwd() + "/" + name + ".html", { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
await p.waitForTimeout(800);
await p.pdf({ path: name + ".pdf", format: "A4", printBackground: true, preferCSSPageSize: true });
await p.screenshot({ path: name + "-sheet.png", clip: { x: 0, y: 0, width: 794, height: 1123 } });
const over = await p.evaluate(() => [...document.querySelectorAll(".tk>*,.p")].filter((e) => e.scrollWidth > e.clientWidth + 1).length);
console.log(name + ": " + (await p.$$(".tk")).length + " stickers, " + (await p.$$(".tab")).length + " tabs, overflow: " + over);
await b.close();
