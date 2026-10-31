/* Sending email through Gmail (smtp.gmail.com, port 465, TLS) with an app password.
   Needs two Cloudflare secrets: SMTP_USER (the Gmail address) and SMTP_PASS (its
   16-character app password). Without them nothing is sent and nothing breaks. */

export function mailReady(env) {
  return !!(env.SMTP_USER && env.SMTP_PASS);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
function b64(s) {
  const bytes = enc.encode(String(s));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
const word = (s) => "=?UTF-8?B?" + b64(s) + "?=";   /* headers that may hold Arabic or emoji */
const bare = (s) => String(s || "").replace(/[\r\n<>"]/g, "").trim();

/* One message: plain text and HTML, both base64 so any language goes through untouched. */
function message(from, fromName, to, subject, text, html) {
  const boundary = "pc" + Math.random().toString(36).slice(2);
  return [
    "From: " + word(fromName) + " <" + from + ">",
    "To: <" + to + ">",
    "Subject: " + word(subject),
    "Date: " + new Date().toUTCString(),
    "Message-ID: <" + Date.now().toString(36) + Math.random().toString(36).slice(2) + "@deestreats.pass>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    "",
    "--" + boundary,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(text)),
    "--" + boundary,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(html)),
    "--" + boundary + "--",
    ""
  ].join("\r\n");
}

async function open(env) {
  const host = env.SMTP_HOST || "smtp.gmail.com", port = Number(env.SMTP_PORT || 465);
  if (env.__connect) return env.__connect(host, port);   /* tests */
  const { connect } = await import("cloudflare:sockets");
  return connect({ hostname: host, port }, { secureTransport: env.SMTP_TLS === "off" ? "off" : "on", allowHalfOpen: false });
}

/* every email the site sends goes in a log (mail_log): when, to whom, what, and whether Gmail took it, with Gmail's
   own words when it didn't. The owner page shows the latest ones, so a customer's receipt can be checked. */
let mailLogReady = false;
async function logMail(env, row) {
  if (!env.DB) return;
  try {
    if (!mailLogReady) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS mail_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT, rcpt TEXT, copies INTEGER, subject TEXT, ok INTEGER NOT NULL, err TEXT)").run();
      mailLogReady = true;
    }
    await env.DB.prepare("INSERT INTO mail_log (at, kind, rcpt, copies, subject, ok, err) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(new Date().toISOString(), row.kind || "", row.rcpt || "", row.copies || 0, String(row.subject || "").slice(0, 200), row.ok ? 1 : 0, row.err ? String(row.err).slice(0, 300) : null).run();
    if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM mail_log WHERE id <= (SELECT MAX(id) FROM mail_log) - 500").run();
  } catch (e) { /* the log never stops an email */ }
}
export async function sendMail(env, opts) {
  if (!mailReady(env)) return false;
  const copies = String(opts.bcc || "").split(/[,;]/).filter((x) => x.trim()).length;
  const row = { kind: opts.kind, rcpt: bare(opts.to), copies, subject: opts.subject };
  try {
    const sent = await sendNow(env, opts);
    /* the main address refused while a copy went: the log shows it as not sent, with Gmail's reason */
    const toRefused = sent && sent.refused ? sent.refused.filter((r) => r.toLowerCase().startsWith(row.rcpt.toLowerCase() + ":")) : [];
    await logMail(env, { ...row, ok: !!sent && !toRefused.length, err: !sent ? "not a valid email address" : sent.refused ? sent.refused.join(" | ") : null });
    return !!sent && !toRefused.length;
  } catch (e) {
    await logMail(env, { ...row, ok: false, err: e && e.message });
    throw e;
  }
}
async function sendNow(env, { to, bcc, subject, text, html, fromName }) {
  if (!mailReady(env)) return false;
  to = bare(to);
  const ok = (a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a);
  if (!ok(to)) return false;
  /* hidden copies: extra recipients that never appear in the message headers */
  const hidden = String(bcc || "").split(/[,;]/).map(bare).filter((a) => ok(a) && a.toLowerCase() !== to.toLowerCase());
  const user = bare(env.SMTP_USER);
  const socket = await open(env);
  const writer = socket.writable.getWriter(), reader = socket.readable.getReader();
  let buf = "";
  /* an SMTP reply ends on a line "NNN text" (a "NNN-" line means more lines follow) */
  const reply = async () => {
    for (;;) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) { const out = lines.slice(0, i + 1).join("\n"); buf = lines.slice(i + 1).join("\r\n"); return out; }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("mail server closed the connection");
      buf += dec.decode(value, { stream: true });
    }
  };
  const step = async (line, want) => {
    if (line != null) await writer.write(enc.encode(line + "\r\n"));
    const r = await reply();
    if (!want.some((c) => r.startsWith(c))) throw new Error("mail server said: " + r.slice(0, 200));
    return r;
  };
  try {
    await step(null, ["220"]);
    await step("EHLO deestreats.pass", ["250"]);
    await step("AUTH LOGIN", ["334"]);
    await step(b64(user), ["334"]);
    await step(b64(String(env.SMTP_PASS).replace(/\s+/g, "")), ["235"]);
    await step("MAIL FROM:<" + user + ">", ["250"]);
    /* one address Gmail turns down (a typo, an account that's gone) doesn't stop the others getting it */
    const refused = [];
    for (const a of [to].concat(hidden)) {
      try { await step("RCPT TO:<" + a + ">", ["250", "251"]); } catch (e) { refused.push(a + ": " + String(e.message || e).replace(/^mail server said: /, "")); }
    }
    if (refused.length === 1 + hidden.length) throw new Error(refused.join(" | "));
    await step("DATA", ["354"]);
    const body = message(user, fromName || "Smash & Pass", to, subject, text, html)
      .split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
    await step(body + "\r\n.", ["250"]);
    await writer.write(enc.encode("QUIT\r\n")).catch(() => {});
    return refused.length ? { refused } : true;
  } finally {
    try { await writer.close(); } catch (e) { /* already closed */ }
    try { socket.close && socket.close(); } catch (e) { /* already closed */ }
  }
}

/* ---------- the emails ---------- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* the Smash & Pass logo comes from this site (public/smash-logo.png), found from the email's own link */
const originOf = (link) => { try { return new URL(link).origin; } catch (e) { return ""; } };
const shell = (inner, link) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#101010;font-family:Arial,Helvetica,sans-serif;color:#FFF9EE">' +
  '<div style="height:6px;background:#FFD21C"></div>' +
  '<div style="max-width:520px;margin:0 auto;padding:22px 18px 28px">' +
  (originOf(link) ? '<img src="' + esc(originOf(link) + "/smash-logo.png") + '" width="150" alt="Smash &amp; Pass" style="display:block;border:0;height:auto;margin:0 0 12px">'
    : '<p style="margin:0 0 4px;font-size:12px;letter-spacing:3px;font-weight:bold;color:#FFF9EE">SMASH &amp; PASS</p>') +
  '<p style="margin:0 0 18px;font-size:30px;font-weight:bold;color:#FFD21C">THE PASS CARD</p>' + inner +
  "</div></body></html>";
export const dubaiTime = (d) => new Date(d || Date.now()).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/* the customer's order email after a stamp */
export function orderEmail({ first, items, receipt, card, need, points, gameMin, link, unsub }) {
  const row = (label, n) => '<tr><td style="padding:6px 0;color:#CFC9BC">' + label + '</td><td style="padding:6px 0;text-align:right;font-weight:bold">' + n + "</td></tr>";
  const freeB = Math.floor(card.burger / need), freeD = Math.floor(card.dessert / need);
  const aed = (n) => (n < 0 ? "− " : "") + "AED " + (Math.round(Math.abs(+n || 0) * 100) / 100).toFixed(2);
  /* the receipt: every item with what it came to, and the total paid */
  const bill = receipt && receipt.rows && receipt.rows.length
    ? '<div style="background:#1E1E1E;border-radius:14px;padding:12px 16px 12px;margin-bottom:14px">' +
      '<p style="margin:0 0 2px;font-size:12px;letter-spacing:2px;color:#B3AEA3;font-weight:bold">YOUR RECEIPT</p>' +
      (receipt.meta ? '<p style="margin:0 0 4px;font-size:12px;color:#8A857B">' + esc(receipt.meta) + "</p>" : "") +
      '<table style="width:100%;border-collapse:collapse;color:#FFF9EE">' +
      receipt.rows.map((r) => '<tr><td style="padding:10px 0;border-bottom:1px dashed #3A3A36;vertical-align:top">' + esc(r.label) +
        (r.sub ? '<div style="font-size:12px;color:#B3AEA3;margin-top:3px">' + esc(r.sub) + "</div>" : "") +
        '</td><td style="padding:10px 0 10px 12px;border-bottom:1px dashed #3A3A36;text-align:right;vertical-align:top;white-space:nowrap;font-weight:bold">' + aed(r.amt) + "</td></tr>").join("") +
      '<tr><td style="padding:13px 0 2px;font-size:15px;font-weight:bold;letter-spacing:1px">TOTAL PAID</td>' +
      '<td style="padding:13px 0 2px 12px;text-align:right;white-space:nowrap;font-size:22px;font-weight:bold;color:#FFD21C">' + aed(receipt.total) + "</td></tr></table></div>"
    : '<div style="background:#1E1E1E;border-radius:14px;padding:14px 16px;margin-bottom:14px">' +
      '<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;color:#B3AEA3;font-weight:bold">YOUR ORDER</p>' +
      '<p style="margin:0">' + esc(items) + "</p></div>";
  const html = shell(
    '<p style="font-size:18px;margin:0 0 6px">Thanks ' + esc(first) + "! 🙌</p>" +
    '<p style="margin:0 0 16px;color:#CFC9BC">Here is your receipt. Your order is on your Pass Card.</p>' + bill +
    '<div style="background:#1E1E1E;border-radius:14px;padding:14px 16px;margin-bottom:14px"><table style="width:100%;border-collapse:collapse;color:#FFF9EE">' +
    row("🍔 Savory card", (card.burger % need) + " / " + need) + row("🍰 Dee'sert card", (card.dessert % need) + " / " + need) +
    (freeB ? row("🎁 Free burgers waiting", freeB) : "") + (freeD ? row("🎁 Free desserts waiting", freeD) : "") +
    row("⚡ Smash Points", points) + "</table></div>" +
    '<p style="margin:0 0 16px;color:#FFD21C;font-weight:bold">🎮 Your games are open for ' + gameMin + " minutes. Play while you wait!</p>" +
    '<p style="margin:0 0 22px"><a href="' + esc(link) + '" style="display:inline-block;background:#FFD21C;color:#101010;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:12px">OPEN MY PASS CARD</a></p>' +
    '<p style="margin:0;font-size:12px;color:#8A857B">You get this because you have a Smash &amp; Pass Pass Card. <a href="' + esc(unsub) + '" style="color:#B3AEA3">Stop order emails</a></p>', link);
  const lines = receipt && receipt.rows && receipt.rows.length
    ? "Your receipt" + (receipt.meta ? " (" + receipt.meta + ")" : "") + ":\n" + receipt.rows.map((r) => r.label + (r.sub ? " (" + r.sub + ")" : "") + " .... " + aed(r.amt)).join("\n") + "\nTOTAL PAID: " + aed(receipt.total)
    : "Your order: " + items;
  const text = "Thanks " + first + "! Here is your receipt. Your order is on your Pass Card.\n\n" + lines +
    "\n\nSavory card: " + (card.burger % need) + "/" + need + "\nDee'sert card: " + (card.dessert % need) + "/" + need +
    (freeB ? "\nFree burgers waiting: " + freeB : "") + (freeD ? "\nFree desserts waiting: " + freeD : "") +
    "\nSmash Points: " + points + "\n\nYour games are open for " + gameMin + " minutes: " + link + "\n\nStop order emails: " + unsub;
  return { subject: receipt && receipt.rows && receipt.rows.length ? "Your Smash & Pass receipt · AED " + (Math.round(receipt.total * 100) / 100).toFixed(2) : "Thanks for your order! Your Pass Card is updated", html, text };
}

/* a sale as a receipt: every line with what it came to, and the total paid.
   rows: [{ label, sub, amt }]; meta: when, where and who logged it */
export function receiptEmail({ title, meta, rows, total, note, link }) {
  const aed = (n) => "AED " + (Math.round((+n || 0) * 100) / 100).toFixed(2);
  const html = shell(
    '<p style="margin:0 0 4px;font-size:12px;letter-spacing:3px;color:#B3AEA3;font-weight:bold">RECEIPT</p>' +
    '<p style="margin:0 0 4px;font-size:20px;font-weight:bold">' + esc(title) + "</p>" +
    '<p style="margin:0 0 14px;font-size:13px;color:#CFC9BC">' + esc(meta) + "</p>" +
    '<div style="background:#1E1E1E;border-radius:14px;padding:4px 16px 12px;margin-bottom:14px"><table style="width:100%;border-collapse:collapse;color:#FFF9EE">' +
    rows.map((r) => '<tr><td style="padding:11px 0;border-bottom:1px dashed #3A3A36;vertical-align:top">' + esc(r.label) +
      (r.sub ? '<div style="font-size:12px;color:#B3AEA3;margin-top:3px">' + esc(r.sub) + "</div>" : "") +
      '</td><td style="padding:11px 0 11px 12px;border-bottom:1px dashed #3A3A36;text-align:right;vertical-align:top;white-space:nowrap;font-weight:bold">' + aed(r.amt) + "</td></tr>").join("") +
    '<tr><td style="padding:14px 0 2px;font-size:15px;font-weight:bold;letter-spacing:1px">TOTAL PAID</td>' +
    '<td style="padding:14px 0 2px 12px;text-align:right;white-space:nowrap;font-size:22px;font-weight:bold;color:#FFD21C">' + aed(total) + "</td></tr></table></div>" +
    (note ? '<p style="margin:0 0 14px;font-size:12.5px;color:#B3AEA3">' + esc(note) + "</p>" : "") +
    (link ? '<p style="margin:0"><a href="' + esc(link) + '" style="color:#FFD21C">Open the dashboard</a></p>' : ""), link);
  const text = "RECEIPT\n" + title + "\n" + meta + "\n\n" + rows.map((r) => r.label + (r.sub ? " (" + r.sub + ")" : "") + " .... " + aed(r.amt)).join("\n") +
    "\n\nTOTAL PAID: " + aed(total) + (note ? "\n\n" + note : "") + (link ? "\n\n" + link : "");
  return { subject: title + " · " + aed(total), html, text };
}

/* the alert to the owner */
export function alertEmail({ title, lines, link }) {
  const html = shell('<p style="font-size:20px;font-weight:bold;margin:0 0 12px">' + esc(title) + "</p>" +
    '<div style="background:#1E1E1E;border-radius:14px;padding:14px 16px;margin-bottom:16px">' +
    lines.map((l) => '<p style="margin:0 0 6px">' + esc(l) + "</p>").join("") + "</div>" +
    (link ? '<p style="margin:0"><a href="' + esc(link) + '" style="color:#FFD21C">Open the dashboard</a></p>' : ""), link);
  return { subject: title, html, text: title + "\n\n" + lines.join("\n") + (link ? "\n\n" + link : "") };
}
