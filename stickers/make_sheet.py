"""The standard Dee's x Smash & Pass sticker sheet (A4).

Top: 3.4 cm square expiry stickers, 5 across x 6 rows (30 per page), "Option C":
a yellow SCAN ME tab on the QR (Pass Card sign-up, /t), logo, emoji, name,
MADE / EXP dates and "10th one FREE".
Bottom: 24 white lid tabs, 4 across x 6 rows, 2 cm | 0.8 cm | 2 cm
(FOLLOW US | logo | @SmashAndPass.DXB), Lilita One, thin grey cut lines.

usage:
  python3 stickers/make_sheet.py --made "14 Oct 2026" --exp "17 Oct 2026" "San Sebastian:9" "Brownie Bag:12" "Chocolate Cake:9"
  python3 stickers/make_sheet.py --tabs-only            # lid tabs only, same spot, to reprint a used sheet
  then: node stickers/render.mjs <out>                   # writes <out>.pdf and <out>-sheet.png
options: --out NAME (default Dees-Smash-stickers), --no-tabs
  --shop slate    Slate's sheet: Slate logo and colours, QR to Slate's own Pass Card (slate.tapntreat1.workers.dev/t).
                  Lid tabs read @slatedxb (instagram.com/slatedxb).
More than 30 stickers spill onto extra pages.
"""
import argparse, base64, io, os, qrcode, qrcode.image.svg

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "https://dees-stock.deestreats2026.workers.dev/t"
EMOJI = {"San Sebastian": "🍰", "Brownie Bag": "🍫", "Chocolate Cake": "🍫🍰", "Crème Brûlée": "🍮", "Mini Pavlova": "🍓", "Lazy Cake": "🍫"}
SHOPS = {   # per shop: where the QR goes, the logo, the accent colour and the text on it, the lid-tab handle
  "smash": {"url": URL, "logo": os.path.join(HERE, "..", "smash-n-pass-brand-deck", "logo.png"), "accent": "#FFD21C", "ink": "#17140F", "handle": "@SmashAndPass.DXB"},
  "slate": {"url": "https://slate.tapntreat1.workers.dev/t", "logo": "/home/user/tapntreat/clients/slate/public/logo.png", "accent": "#8F352D", "ink": "#FFFFFF", "handle": "@slatedxb", "tabLogo": False, "handlePt": 8.6},
}
PER_PAGE = 30

ap = argparse.ArgumentParser()
ap.add_argument("--made"); ap.add_argument("--exp")
ap.add_argument("--out", default="Dees-Smash-stickers")
ap.add_argument("--tabs-only", action="store_true"); ap.add_argument("--no-tabs", action="store_true")
ap.add_argument("--shop", default="smash", choices=sorted(SHOPS)); ap.add_argument("--handle")
ap.add_argument("items", nargs="*", help='"Name:count"')
a = ap.parse_args()
if not a.tabs_only and not (a.made and a.exp and a.items):
    ap.error("give --made, --exp and at least one \"Name:count\" (or --tabs-only)")

b64 = lambda p: base64.b64encode(open(p, "rb").read()).decode()
SH = SHOPS[a.shop]; URL = SH["url"]; HANDLE = a.handle if a.handle is not None else SH["handle"]
if not HANDLE: a.no_tabs = True   # no handle on file: no lid tabs rather than a made-up one
logo = "data:image/png;base64," + b64(SH["logo"])
lilita = "data:font/ttf;base64," + b64(os.path.join(HERE, "LilitaOne.ttf"))
buf = io.BytesIO(); qrcode.make(URL, image_factory=qrcode.image.svg.SvgPathImage, border=1).save(buf)
qr = "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode()
IG = ('<svg class="ig" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="6" fill="none" stroke="#17140F" stroke-width="2.4"/>'
      '<circle cx="12" cy="12" r="4.6" fill="none" stroke="#17140F" stroke-width="2.4"/><circle cx="17.6" cy="6.4" r="1.5" fill="#17140F"/></svg>')

def sticker(name):
    """fills the whole square: QR and logo on top, the name beside it, the two dates across the width, a full-width FREE bar at the foot"""
    return (f'<div class="tk"><div class="top"><div class="qcol"><img class="lg" src="{logo}"><img class="q" src="{qr}"></div>'
            f'<div class="side"><div class="pill">SCAN ME</div><span class="emo">{EMOJI.get(name, "")}</span><div class="prod">{name}</div></div></div>'
            f'<div class="dates"><div class="dt"><span>MADE</span> {a.made}</div><div class="dt best"><span>EXP</span> {a.exp}</div></div>'
            f'<div class="cta">10th one FREE 🎁</div></div>')

TAB_MID = f'<img src="{logo}">' if SH.get("tabLogo", True) else ""   # Slate: plain fold strip, no logo
TAB = (f'<div class="tab"><div class="p l">{IG}<span>FOLLOW US</span></div><div class="p m">{TAB_MID}</div>'
       f'<div class="p r"><span>{HANDLE}</span></div></div>')

names = [] if a.tabs_only else [n for spec in a.items for n in [spec.rsplit(":", 1)[0]] * int(spec.rsplit(":", 1)[1])]
pages = [names[i:i + PER_PAGE] for i in range(0, len(names), PER_PAGE)] or [[]]
tabs = "" if a.no_tabs else f'<div class="tabs">{TAB * 24}</div>'
body = "".join(f'<div class="sheet"><div class="grid">{"".join(sticker(n) for n in pg)}</div>{tabs}</div>' for pg in pages)

html = f"""<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Cairo:wght@600;700;900&display=swap">
<style>
@font-face{{font-family:'Lilita Local';src:url({lilita}) format('truetype')}}
*{{box-sizing:border-box;margin:0;padding:0}}@page{{size:A4;margin:0}}
body{{background:#fff;font-family:Cairo,sans-serif;color:#1C1917}}
.sheet{{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always;break-after:page}}
.grid{{position:absolute;left:0;right:0;top:8mm;display:grid;grid-template-columns:repeat(5,34mm);grid-auto-rows:34mm;gap:2mm;justify-content:center}}
.tk{{width:34mm;height:34mm;border:0.3mm dashed #C9BCA4;border-radius:1.8mm;display:flex;flex-direction:column;justify-content:space-between;gap:0.6mm;padding:1.2mm;overflow:hidden}}
.top{{display:flex;align-items:stretch;gap:1.2mm;flex:1;min-height:0}}
.qcol{{display:flex;flex-direction:column;align-items:stretch;flex:none;width:16mm}}
.pill{{font-family:'Baloo 2',sans-serif;font-weight:800;background:{SH["accent"]};color:{SH["ink"]};text-align:center;line-height:1;letter-spacing:.04em;font-size:6pt;padding:0.9mm 0 0.7mm;border-radius:1mm}}
.q{{display:block;width:16mm;height:16mm;border:0.5mm solid {SH["accent"]};border-radius:1mm}}
.side{{flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch;justify-content:space-between;gap:0.5mm}}
.lg{{height:{"7mm" if a.shop == "slate" else "5.5mm"};width:16mm;object-fit:contain;object-position:center;margin-bottom:0.5mm}}
.emo{{font-size:11pt;line-height:1;white-space:nowrap}}
.prod{{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:7pt;color:#4A2C2A;line-height:1.05}}
.dates{{display:flex;flex-direction:column;gap:0.3mm;margin-top:0.6mm}}
.dt{{font-size:6.2pt;color:#2B1E1A;font-weight:700;white-space:nowrap;line-height:1.1}}
.dt span{{font-weight:900;color:#9A8A7C}}.dt.best{{color:#8A5A06}}.dt.best span{{color:#B7791A}}
.cta{{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:6.4pt;color:{SH["ink"]};background:{SH["accent"]};text-align:center;white-space:nowrap;line-height:1;padding:1mm 0 0.8mm;border-radius:1mm}}
.tabs{{position:absolute;left:0;right:0;top:226.97mm;display:grid;grid-template-columns:repeat(4,48mm);grid-auto-rows:9mm;gap:2mm;justify-content:center}}
.tab{{width:48mm;height:9mm;background:#fff;border:0.25mm dashed #CFC6B6;border-radius:1mm;display:grid;grid-template-columns:20mm 8mm 20mm;overflow:hidden}}
.p{{display:flex;align-items:center;justify-content:center;gap:0.9mm;white-space:nowrap;color:#17140F;min-width:0;overflow:hidden}}
.p.m{{border-left:0.25mm dashed #CFC6B6;border-right:0.25mm dashed #CFC6B6}}
.p.m img{{height:3.8mm;width:auto;max-width:7mm;object-fit:contain}}
.p.l span{{font-family:'Lilita Local','Lilita One','Arial Black',sans-serif;font-size:7.4pt;letter-spacing:.03em;line-height:1}}
.p.r span{{font-family:'Lilita Local','Lilita One','Arial Black',sans-serif;font-size:{SH.get("handlePt", 5.4)}pt;line-height:1}}
.ig{{width:3.4mm;height:3.4mm;display:block;flex:none}}
</style></head><body>{body}</body></html>"""
open(a.out + ".html", "w", encoding="utf-8").write(html)
print(f"{a.out}.html: {len(names)} stickers on {len(pages)} page(s), {'no' if a.no_tabs else 24 * len(pages)} lid tabs")
