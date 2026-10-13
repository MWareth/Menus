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

export async function sendMail(env, { to, subject, text, html, fromName }) {
  if (!mailReady(env)) return false;
  to = bare(to);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return false;
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
    await step("RCPT TO:<" + to + ">", ["250", "251"]);
    await step("DATA", ["354"]);
    const body = message(user, fromName || "Smash & Pass", to, subject, text, html)
      .split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
    await step(body + "\r\n.", ["250"]);
    await writer.write(enc.encode("QUIT\r\n")).catch(() => {});
    return true;
  } finally {
    try { await writer.close(); } catch (e) { /* already closed */ }
    try { socket.close && socket.close(); } catch (e) { /* already closed */ }
  }
}

/* ---------- the emails ---------- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shell = (inner) => '<!doctype html><html><body style="margin:0;background:#101010;font-family:Arial,Helvetica,sans-serif;color:#FFF9EE">' +
  '<div style="max-width:520px;margin:0 auto;padding:24px 18px">' +
  '<p style="margin:0 0 4px;font-size:12px;letter-spacing:3px;font-weight:bold;color:#FFF9EE">SMASH &amp; PASS</p>' +
  '<p style="margin:0 0 18px;font-size:30px;font-weight:bold;color:#FFD21C">THE PASS CARD</p>' + inner +
  "</div></body></html>";
export const dubaiTime = (d) => new Date(d || Date.now()).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/* the customer's order email after a stamp */
export function orderEmail({ first, items, card, need, points, gameMin, link, unsub }) {
  const row = (label, n) => '<tr><td style="padding:6px 0;color:#CFC9BC">' + label + '</td><td style="padding:6px 0;text-align:right;font-weight:bold">' + n + "</td></tr>";
  const freeB = Math.floor(card.burger / need), freeD = Math.floor(card.dessert / need);
  const html = shell(
    '<p style="font-size:18px;margin:0 0 6px">Thanks ' + esc(first) + "! 🙌</p>" +
    '<p style="margin:0 0 16px;color:#CFC9BC">Your order is on your Pass Card.</p>' +
    '<div style="background:#1E1E1E;border-radius:14px;padding:14px 16px;margin-bottom:14px">' +
    '<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;color:#B3AEA3;font-weight:bold">YOUR ORDER</p>' +
    '<p style="margin:0">' + esc(items) + "</p></div>" +
    '<div style="background:#1E1E1E;border-radius:14px;padding:14px 16px;margin-bottom:14px"><table style="width:100%;border-collapse:collapse;color:#FFF9EE">' +
    row("🍔 Burger card", (card.burger % need) + " / " + need) + row("🍰 Dee'sert card", (card.dessert % need) + " / " + need) +
    (freeB ? row("🎁 Free burgers waiting", freeB) : "") + (freeD ? row("🎁 Free desserts waiting", freeD) : "") +
    row("⚡ Smash Points", points) + "</table></div>" +
    '<p style="margin:0 0 16px;color:#FFD21C;font-weight:bold">🎮 Your games are open for ' + gameMin + " minutes. Play while you wait!</p>" +
    '<p style="margin:0 0 22px"><a href="' + esc(link) + '" style="display:inline-block;background:#FFD21C;color:#101010;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:12px">OPEN MY PASS CARD</a></p>' +
    '<p style="margin:0;font-size:12px;color:#8A857B">You get this because you have a Smash &amp; Pass Pass Card. <a href="' + esc(unsub) + '" style="color:#B3AEA3">Stop order emails</a></p>');
  const text = "Thanks " + first + "! Your order is on your Pass Card.\n\nYour order: " + items +
    "\nBurger card: " + (card.burger % need) + "/" + need + "\nDee'sert card: " + (card.dessert % need) + "/" + need +
    (freeB ? "\nFree burgers waiting: " + freeB : "") + (freeD ? "\nFree desserts waiting: " + freeD : "") +
    "\nSmash Points: " + points + "\n\nYour games are open for " + gameMin + " minutes: " + link + "\n\nStop order emails: " + unsub;
  return { subject: "Thanks for your order! Your Pass Card is updated", html, text };
}

/* the alert to the owner */
export function alertEmail({ title, lines, link }) {
  const html = shell('<p style="font-size:20px;font-weight:bold;margin:0 0 12px">' + esc(title) + "</p>" +
    '<div style="background:#1E1E1E;border-radius:14px;padding:14px 16px;margin-bottom:16px">' +
    lines.map((l) => '<p style="margin:0 0 6px">' + esc(l) + "</p>").join("") + "</div>" +
    (link ? '<p style="margin:0"><a href="' + esc(link) + '" style="color:#FFD21C">Open the dashboard</a></p>' : ""));
  return { subject: title, html, text: title + "\n\n" + lines.join("\n") + (link ? "\n\n" + link : "") };
}
