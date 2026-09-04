/**
 * Builds public/index.html from the board app.
 *
 * The screens are the same ones the team already knows — the only thing that
 * changes is where the data lives. The old build kept the board inside the
 * page and republished the whole page to save; this one talks to the Worker.
 * Doing it as a transform rather than a fork means the two never drift.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, "..", "dees-stock-app", "index.html");
const OUT = path.join(here, "public", "index.html");

const src = fs.readFileSync(SOURCE, "utf8");
const css = src.match(/<style id="app-style">([\s\S]*?)<\/style>/)[1].trim();
let js = src.match(/<script id="app-code">([\s\S]*?)\n<\/script>/)[1].trim();

/** Replace exactly once, and shout if the anchor moved. */
function swap(from, to, label) {
  const n = js.split(from).length - 1;
  if (n !== 1) throw new Error(`anchor "${label}" matched ${n} times, expected 1`);
  js = js.replace(from, to);
}
function cut(from, label) { swap(from, "", label); }

/* ---- 1. the board arrives from the server, not from the page ---- */
swap(
  '  var S = JSON.parse(document.getElementById("app-state").textContent);\n' +
  '  var app = document.getElementById("app");\n' +
  "  var artifact = null;\n" +
  "  var dl = null;                 /* the downloads capability, once it answers */\n",
  '  var S = null;                  /* the board, once the server hands it over */\n' +
  "  var version = 0;               /* what we last saw; a save carries it back */\n" +
  '  var app = document.getElementById("app");\n' +
  "  var dl = true;                 /* a browser can always be handed a file */\n",
  "state header"
);

/* ---- 2. talking to the server ---- */
swap(
  "  /* ============ persistence ============ */",
  `  /* ============ persistence ============
     The board lives in the database behind this site. Every save carries the
     version it was built on, so two people saving at once cannot silently
     overwrite each other — the loser is handed the winner's board instead. */
  function api(path, body) {
    return fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store"
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; },
                           function () { return { status: r.status, body: {} }; });
    });
  }

  function adopt(r) {
    S = r.body.state;
    version = r.body.version;
    if (r.body.me) me = r.body.me;
  }

  function loadState() {
    return api("/api/state").then(function (r) {
      if (r.status === 401) { me = null; S = null; return false; }
      if (!r.body.ok) { toast("Could not load the board.", true); return false; }
      adopt(r);
      return true;
    }, function () { toast("No connection.", true); return false; });
  }
`,
  "persistence header"
);

/* ---- 3. buildDoc belonged to the self-republishing page ---- */
const buildDocStart = js.indexOf("  function buildDoc(next) {");
const buildDocEnd = js.indexOf("\n  }\n", buildDocStart) + 5;
if (buildDocStart < 0 || buildDocEnd < 5) throw new Error("buildDoc not found");
js = js.slice(0, buildDocStart) + js.slice(buildDocEnd);

/* ---- 4. save posts the board instead of republishing the page ---- */
const saveStart = js.indexOf("  function save(mutate, okMsg) {");
const saveEnd = js.indexOf("\n  }\n", js.indexOf("artifact.publish(", saveStart)) + 5;
if (saveStart < 0) throw new Error("save() not found");
js = js.slice(0, saveStart) + `  function save(mutate, okMsg) {
    if (busy) return;
    var next = clone(S);
    var restoreSeq = S.seq;
    S.seq = next.seq = restoreSeq;
    try { mutate(next); } catch (e) { toast(e.message || "Could not save.", true); return; }
    next.seq = S.seq;
    busy = true; render();
    api("/api/state", { version: version, state: next }).then(function (r) {
      busy = false;
      if (r.status === 401) { me = null; S = null; render(); return; }
      if (r.status === 409) {
        adopt(r); render();
        toast("Someone saved first \\u2014 this is their board.", true);
        return;
      }
      if (!r.body.ok) { toast("Could not save. Try again.", true); render(); return; }
      adopt(r); render();
      toast(okMsg || "Saved.");
    }, function () {
      busy = false; render();
      toast("No connection \\u2014 that was not saved.", true);
    });
  }
` + js.slice(saveEnd);

/* ---- 5. the PIN is checked on the server now ---- */
const loginStart = js.indexOf("  function doLogin() {");
const loginEnd = js.indexOf("\n  }\n", js.indexOf("hash(pin).then(", loginStart)) + 5;
if (loginStart < 0) throw new Error("doLogin() not found");
js = js.slice(0, loginStart) + `  function doLogin() {
    if (lockedFor()) { renderLock(); return; }
    var whoEl = document.getElementById("who"), pinEl = document.getElementById("pin");
    if (!whoEl || !pinEl) return;
    var who = (whoEl.value || "").trim(), pin = (pinEl.value || "").trim();
    if (!who || !pin) { lockErr = "Enter your username and PIN."; renderLock(); return; }
    var btn = document.querySelector('#loginform button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "SIGNING IN\\u2026"; }
    api("/api/login", { user: who, pin: pin }).then(function (r) {
      if (r.status !== 200 || !r.body.ok) {
        noteFail();
        lockErr = r.body.error || "That username and PIN don't match.";
        renderLock();
        return;
      }
      clearFail(); lockErr = "";
      loadState().then(function (ok) {
        if (!ok) { renderLock(); return; }
        var seen = "";
        try { seen = sessionStorage.getItem("deeserts.tab") || ""; } catch (e) {}
        if (!seen) tab = homeTab(me);
        render();
      });
    }, function () { lockErr = "No connection. Try again."; renderLock(); });
  }
` + js.slice(loginEnd);

/* ---- 6. changing your own PIN, and signing out ---- */
const pinStart = js.indexOf("  function changePin() {");
const pinEnd = js.indexOf("\n  }\n", js.indexOf("hash(oldPin).then(", pinStart)) + 5;
if (pinStart < 0) throw new Error("changePin() not found");
js = js.slice(0, pinStart) + `  function changePin() {
    var oldEl = document.getElementById("pw-old"),
        newEl = document.getElementById("pw-new"),
        twoEl = document.getElementById("pw-two");
    var oldPin = (oldEl.value || "").trim(),
        newPin = (newEl.value || "").trim(),
        twoPin = (twoEl.value || "").trim();
    if (!oldPin || !newPin) { toast("Fill in your current PIN and the new one.", true); return; }
    if (!/^\\d{4,8}$/.test(newPin)) { toast("New PIN must be 4\\u20138 digits.", true); return; }
    if (newPin !== twoPin) { toast("The two new PINs do not match.", true); return; }
    if (newPin === oldPin) { toast("That is already your PIN.", true); return; }
    api("/api/pin", { oldPin: oldPin, newPin: newPin }).then(function (r) {
      if (!r.body.ok) { toast(r.body.error || "Could not change your PIN.", true); return; }
      loadState().then(function () { render(); toast("PIN changed."); });
    }, function () { toast("No connection.", true); });
  }
` + js.slice(pinEnd);

swap(
  `  function signOut() {
    me = null;
    try { sessionStorage.removeItem("deeserts.uid"); } catch (e) {}
    render();
  }`,
  `  function signOut() {
    try { sessionStorage.removeItem("deeserts.tab"); } catch (e) {}
    api("/api/logout", {}).then(function () { me = null; S = null; tab = "stock"; render(); });
  }`,
  "signOut"
);

/* ---- 7. the session is a cookie now, not a note to ourselves ---- */
swap(
  `      var uid = sessionStorage.getItem("deeserts.uid");
      if (uid && user(uid)) me = user(uid);
      var f = sessionStorage.getItem("deeserts.flash");
      if (f) { sessionStorage.removeItem("deeserts.flash"); setTimeout(function () { toast(f); }, 60); }
      var t = sessionStorage.getItem("deeserts.tab");`,
  `      var t = sessionStorage.getItem("deeserts.tab");`,
  "loadSession"
);
swap(
  `      if (t) tab = t;
      else if (me) tab = homeTab(me);`,
  `      if (t) tab = t;`,
  "loadSession tab"
);

/* ---- 8. render has to cope with not having a board yet ---- */
swap(
  "  function render() {\n    if (!me) { renderLock(); return; }",
  "  function render() {\n    if (!me || !S) { renderLock(); return; }",
  "render guard"
);

/* ---- 9. the invoice is an ordinary download here ---- */
const invStart = js.indexOf("  function saveInvoice(dropKey) {");
const invEnd = js.indexOf("\n  }\n", js.indexOf("dl.save(", invStart)) + 5;
if (invStart < 0) throw new Error("saveInvoice() not found");
js = js.slice(0, invStart) + `  function saveInvoice(dropKey) {
    var inv;
    try { inv = invoice(dropKey); } catch (e) { inv = null; }
    if (!inv) { toast("Could not build that invoice.", true); return; }
    try {
      var url = URL.createObjectURL(new Blob([inv.bytes], { type: "application/pdf" }));
      var a = document.createElement("a");
      a.href = url; a.download = inv.filename; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
      toast(inv.filename + " saved.");
    } catch (e) { toast("Could not save the invoice here.", true); }
  }
` + js.slice(invEnd);

/* ---- 10. boot ---- */
const bootStart = js.indexOf("  /* ============ boot ============ */");
if (bootStart < 0) throw new Error("boot not found");
js = js.slice(0, bootStart) + `  /* ============ boot ============ */
  loadSession();
  app.innerHTML = '<div class="lock"><div class="lockbox" style="text-align:center">' +
    '<div class="logo" role="img" aria-label="Dee\\'s Treats" style="margin:0 auto 14px"></div>' +
    "<p style=\\"margin:0\\">Loading the board\\u2026</p></div></div>";
  loadState().then(function (ok) {
    if (!ok) { renderLock(); return; }
    var seen = "";
    try { seen = sessionStorage.getItem("deeserts.tab") || ""; } catch (e) {}
    if (!seen) tab = homeTab(me);
    render();
  });

  /* the board is shared, so pick up other people's changes when the phone
     comes back to the front rather than showing a stale count */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && me && !busy) {
      loadState().then(function (ok) { if (ok) render(); });
    }
  });
})();
`;

if (js.indexOf("claude.use(") >= 0) throw new Error("a claude.use() call survived the transform");
if (js.indexOf("buildDoc") >= 0) throw new Error("buildDoc survived the transform");
if (js.indexOf("</scr" + "ipt>") >= 0) throw new Error("the code contains a closing script tag");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#4A2C2A">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Dee's Stock">
<title>Dee's Stock</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8D%AE%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Cairo:wght@400;600;700;900&display=swap">
<style>
${css}
</style>
</head>
<body>
<div id="app"></div>
<script>
${js}
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log("built public/index.html —", (html.length / 1024).toFixed(1), "KB");
