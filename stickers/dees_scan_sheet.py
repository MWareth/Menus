"""Dee's "Scan & win a treat" round stickers, 50 mm, on A4: 3 across x 5 down (15 a page).
The QR opens Dee's Treats Card sign-up (/t, counted as a scan on the owner page).
usage: python3 stickers/dees_scan_sheet.py [--url URL] [--pages N] [--out NAME]   then: node stickers/render.mjs NAME"""
import argparse, base64, io, os, qrcode
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(); ap.add_argument("--url", default="https://deestreats.tapntreat1.workers.dev/t")
ap.add_argument("--pages", type=int, default=1); ap.add_argument("--out", default="Dees-scan-stickers")
ap.add_argument("--mix", action="store_true", help="half circles, half rounded squares: 45 mm, 4 across x 6 down (12 + 12) a page")
ap.add_argument("--six", action="store_true", help="with --mix: 6 across x 8 down, 32 mm (24 + 24) a page, bigger words")
ap.add_argument("--box", action="store_true", help="cake boxes: 50 mm round, 4 across x 5 down (20 a page), the address printed under the QR")
ap.add_argument("--five", action="store_true", help="with --mix: 5 across x 7 down, 38 mm (20 round + 15 rounded squares) a page")
a = ap.parse_args()
b64 = lambda p: base64.b64encode(open(p, "rb").read()).decode()
F = lambda p: "data:font/ttf;base64," + b64(os.path.join(HERE, p))
logo = "data:image/png;base64," + b64(os.path.join(HERE, "dees", "logo-brown.png"))
q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=1, box_size=20); q.add_data(a.url); q.make(fit=True)
buf = io.BytesIO(); q.make_image(fill_color=(84, 53, 33), back_color="white").convert("RGB").save(buf, "PNG")
qr = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
ST = (f'<div class="A"><img class="lg" src="{logo}"><div class="qw"><img src="{qr}"></div>'
      + (f'<div class="u">{a.url.split("://")[-1].rstrip("/")}</div>' if a.box else '') +
      '<div class="t">SCAN &amp; WIN A TREAT 🎁</div><div class="s">Collect stamps · your 10th is FREE</div>'
      '<div class="ar">اختم 9 والـ10 علينا</div></div>')
SQ = ST.replace('class="A"', 'class="A sq"')
N = 24 if a.six else 12
NR, NS = (20, 15) if a.five else (N, N)
small = a.six or a.five
PAGE = (ST * NR + SQ * NS) if a.mix else ST * 20 if a.box else ST * 15
COLS, SIZE, GAP = (4, 50, "2mm 1.5mm") if a.box else (5, 38, "3mm 3mm") if a.five else (6, 32, "3mm 2.5mm") if a.six else (4, 45, "3mm 4mm") if a.mix else (3, 50, "6mm 10mm")
sheets = "".join(f'<div class="sheet"><div class="grid">{PAGE}</div></div>' for _ in range(a.pages))
html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:Lil;src:url({F("LilitaOne.ttf")})}}@font-face{{font-family:Cairo;font-weight:700;src:url({F("fonts/Cairo-Bold.ttf")})}}@font-face{{font-family:Cairo;font-weight:900;src:url({F("fonts/Cairo-Black.ttf")})}}
*{{box-sizing:border-box;margin:0;padding:0}}@page{{size:A4;margin:0}}body{{background:#fff;font-family:Cairo,sans-serif;color:#543521}}
.sheet{{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always;break-after:page}}
.grid{{position:absolute;top:{"19.5mm" if a.box else "6.5mm" if a.five else "9mm" if a.six else "6mm" if a.mix else "11.5mm"};left:0;right:0;display:grid;grid-template-columns:repeat({COLS},{SIZE}mm);grid-auto-rows:{SIZE}mm;gap:{GAP};justify-content:center}}
.grid .A{{zoom:{SIZE / 50}}}.A.sq{{border-radius:7mm}}
.A{{width:50mm;height:50mm;border-radius:50%;background:#F8F3EA;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.9mm;border:0.6mm solid #543521}}
.A .lg{{height:7mm}}.A .qw{{background:#fff;border-radius:2mm;padding:1mm}}.A .qw img{{width:21mm;height:21mm;display:block}}
.A .t{{font-family:Lil;font-size:8.4pt;letter-spacing:.03em;line-height:1}}.A .s{{font-size:5.2pt;font-weight:700;line-height:1}}.A .ar{{font-size:5.4pt;font-weight:900;line-height:1;direction:rtl}}
{'.A .lg{height:6.5mm}.A .qw img{width:22mm;height:22mm}.A .t{font-size:9.6pt}.A .s{font-size:6.2pt}.A .ar{font-size:6.6pt}.A:not(.sq){gap:0.6mm;padding-top:1.5mm}.A:not(.sq) .lg{height:5mm}.A:not(.sq) .qw img{width:18.5mm;height:18.5mm}.A:not(.sq) .t{font-size:8.8pt}.A:not(.sq) .s{font-size:5.6pt}.A:not(.sq) .ar{font-size:6pt}.A .ar{font-size:7.4pt}.A:not(.sq) .ar{font-size:7pt}' if small else ''}{'.A{gap:0.7mm;padding-bottom:2.2mm}.A .lg{height:6.5mm}.A .qw img{width:20mm;height:20mm}.A .u{font-size:6pt;font-weight:900;letter-spacing:.02em;line-height:1;margin-top:-0.2mm}.A .t{font-size:9pt}.A .s{font-size:5.6pt}.A .ar{font-size:7.4pt}' if a.box else ''}{'.A:not(.sq) .lg{height:6mm}.A:not(.sq) .qw img{width:20.5mm;height:20.5mm}.A:not(.sq) .t{font-size:9.4pt}.A:not(.sq) .s{font-size:6pt}.A:not(.sq) .ar{font-size:7.4pt}' if a.five else ''}
</style></head><body>{sheets}</body></html>"""
open(a.out + ".html", "w", encoding="utf-8").write(html); what = f"{20 * a.pages} round stickers (50 mm) for cake boxes" if a.box else f"{NR * a.pages} round + {NS * a.pages} rounded-square stickers ({SIZE} mm)" if a.mix else f"{15 * a.pages} round stickers (50 mm)"
print(f"{a.out}.html: {what} on {a.pages} A4 page(s) -> {a.url}")
