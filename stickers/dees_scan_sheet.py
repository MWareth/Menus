"""Dee's "Scan & win a treat" round stickers, 50 mm, on A4: 3 across x 5 down (15 a page).
The QR opens Dee's Treats Card sign-up (/t, counted as a scan on the owner page).
usage: python3 stickers/dees_scan_sheet.py [--url URL] [--pages N] [--out NAME]   then: node stickers/render.mjs NAME"""
import argparse, base64, io, os, qrcode
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(); ap.add_argument("--url", default="https://deestreats.tapntreat1.workers.dev/t")
ap.add_argument("--pages", type=int, default=1); ap.add_argument("--out", default="Dees-scan-stickers"); a = ap.parse_args()
b64 = lambda p: base64.b64encode(open(p, "rb").read()).decode()
F = lambda p: "data:font/ttf;base64," + b64(os.path.join(HERE, p))
logo = "data:image/png;base64," + b64(os.path.join(HERE, "dees", "logo-brown.png"))
q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=1, box_size=20); q.add_data(a.url); q.make(fit=True)
buf = io.BytesIO(); q.make_image(fill_color=(84, 53, 33), back_color="white").convert("RGB").save(buf, "PNG")
qr = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
ST = (f'<div class="A"><img class="lg" src="{logo}"><div class="qw"><img src="{qr}"></div>'
      '<div class="t">SCAN &amp; WIN A TREAT 🎁</div><div class="s">Collect stamps · your 10th is FREE</div>'
      '<div class="ar">امسح واربح حلا · العاشر مجاناً</div></div>')
sheets = "".join(f'<div class="sheet"><div class="grid">{ST * 15}</div></div>' for _ in range(a.pages))
html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:Lil;src:url({F("LilitaOne.ttf")})}}@font-face{{font-family:Cairo;font-weight:700;src:url({F("fonts/Cairo-Bold.ttf")})}}@font-face{{font-family:Cairo;font-weight:900;src:url({F("fonts/Cairo-Black.ttf")})}}
*{{box-sizing:border-box;margin:0;padding:0}}@page{{size:A4;margin:0}}body{{background:#fff;font-family:Cairo,sans-serif;color:#543521}}
.sheet{{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always;break-after:page}}
.grid{{position:absolute;top:11.5mm;left:0;right:0;display:grid;grid-template-columns:repeat(3,50mm);grid-auto-rows:50mm;gap:6mm 10mm;justify-content:center}}
.A{{width:50mm;height:50mm;border-radius:50%;background:#F8F3EA;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.9mm;border:0.6mm solid #543521}}
.A .lg{{height:7mm}}.A .qw{{background:#fff;border-radius:2mm;padding:1mm}}.A .qw img{{width:21mm;height:21mm;display:block}}
.A .t{{font-family:Lil;font-size:8.4pt;letter-spacing:.03em;line-height:1}}.A .s{{font-size:5.2pt;font-weight:700;line-height:1}}.A .ar{{font-size:5.4pt;font-weight:900;line-height:1;direction:rtl}}
</style></head><body>{sheets}</body></html>"""
open(a.out + ".html", "w", encoding="utf-8").write(html); print(f"{a.out}.html: {15 * a.pages} round stickers (50 mm) on {a.pages} A4 page(s) -> {a.url}")
