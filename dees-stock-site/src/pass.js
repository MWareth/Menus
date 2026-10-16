/**
 * The Pass Card — Smash & Pass loyalty, on the same site as Dee's Stock.
 *
 * Customers have their own tables and their own cookie ("pc"); nothing they
 * can reach touches the stock board. Staff are the stock app's own users
 * (the "ds" cookie), so the truck stamps cards with the login it already has.
 *
 * A card fills at 9 stamps and the 10th item is free. Every burger or dessert
 * bought is a stamp; a Brownie Bag (2 pieces) is 2. The first review earns
 * one bonus stamp. Each customer's QR is their own: the card link carries
 * their number plus a short signature, so it is unique to that number and
 * cannot be made up for someone else's.
 */
import qrcode from "qrcode-generator";
import { mailReady, sendMail, orderEmail, alertEmail, dubaiTime } from "./mail.js";

export const NEED = 9;
/* `off` = not sold right now: kept so past visits still read right, hidden from the truck */
export const PASS_MENU = [
  { id: "burger", name: "Burger", card: "burger", stamps: 1 },
  { id: "ss", name: "San Sebastian", card: "dessert", stamps: 1, stock: "San Sebastian" },
  { id: "brownie", name: "Brownie Bag (2 pcs)", card: "dessert", stamps: 1, stock: "Brownie Bag" },
  { id: "cb", name: "Crème Brûlée", card: "dessert", stamps: 1, stock: "Crème Brûlée" },
  { id: "choc", name: "Chocolate Cake", card: "dessert", stamps: 1, stock: "Chocolate Cake" },
  { id: "lazy", name: "Lazy Cake", card: "dessert", stamps: 1, stock: "Lazy Cake", off: true },
  { id: "pav", name: "Mini Pavlova", card: "dessert", stamps: 1, stock: "Mini Pavlova", off: true },
  { id: "smash", name: "Smashed burger", card: "burger", stamps: 1, off: true },
  { id: "double", name: "Double smash", card: "burger", stamps: 1, off: true },
  { id: "chicken", name: "Chicken burger", card: "burger", stamps: 1, off: true }
];
const MENU_BY_ID = new Map(PASS_MENU.filter((m) => !m.off).map((m) => [m.id, m]));   /* only what's on sale can be stamped or given */

/* ---- Smash Points: earned from orders, the game zone, scratch cards and achievements,
   spent at the window on rewards. Every stamped order unlocks 1 game + 1 scratch card
   (for 48 hours), so nobody can farm points from home. ---- */
export const POINTS_PER_STAMP = 10;
export const GAMES = ["stack", "catch", "crack", "smash"];
const GAME_MAX = 2;                          // Smash Points for every game played, whatever the score
export const GAME_WINDOW_MIN = 30;           // after a stamp, games are open (unlimited) for this long, then lock
/* only the first game of each order earns GAME_MAX points; the rest are for fun and the leaderboard */
const TOKEN_HOURS = 48;
const SCRATCH = [[10, 35], [15, 30], [25, 20], [50, 12], [100, 3]];   // [points, chance %]
export const REWARDS = [
  { id: "dessert", name: "Free dessert", card: "dessert", cost: 400 },
  { id: "burger", name: "Free burger", card: "burger", cost: 900 }
];
export const ACHIEVEMENTS = [
  { id: "first_order", name: "First order", icon: "🎉", pts: 20, how: "Your first stamped order" },
  { id: "first_review", name: "Critic", icon: "⭐", pts: 20, how: "Rate a visit" },
  { id: "first_card", name: "Card complete", icon: "✅", pts: 30, how: "Finish a card" },
  { id: "all_desserts", name: "Dessert explorer", icon: "🍰", pts: 50, how: "Try San Sebastian, Brownie Bag and Crème Brûlée" },
  { id: "regular_month", name: "Regular", icon: "📅", pts: 50, how: "5 visits in one month" },
  { id: "high_score", name: "Pro gamer", icon: "🎮", pts: 30, how: "Score 90+ in a game" }
];
const PC_DAYS = 180;
const MAX_FAILS = 5;
const LOCK_MIN = 15;

let readyDone = false;
async function ensureTables(env) {
  if (readyDone) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS pass_customers (phone TEXT PRIMARY KEY, first TEXT NOT NULL, last TEXT NOT NULL," +
      " email TEXT, pin TEXT NOT NULL, offers INTEGER NOT NULL DEFAULT 0, burger INTEGER NOT NULL DEFAULT 0," +
      " dessert INTEGER NOT NULL DEFAULT 0, bonus INTEGER NOT NULL DEFAULT 0, joined TEXT NOT NULL," +
      " fails INTEGER NOT NULL DEFAULT 0, lock_until TEXT, surprise TEXT, surprise_at TEXT)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS pass_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL," +
      " at TEXT NOT NULL, items TEXT NOT NULL, by TEXT, burger INTEGER NOT NULL DEFAULT 0," +
      " dessert INTEGER NOT NULL DEFAULT 0, food INTEGER, vibe INTEGER, comment TEXT, reviewed_at TEXT)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS pass_redeems (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL," +
      " at TEXT NOT NULL, card TEXT NOT NULL, item TEXT NOT NULL, by TEXT, stock TEXT)"
    ),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pass_scans (day TEXT NOT NULL, src TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, src))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pass_scan_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, src TEXT NOT NULL)"),
    /* one row each time a card fills up (9 stamps); feeds the counter, the fan level and Top Smashers */
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pass_completions (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL," +
      " card TEXT NOT NULL, at TEXT NOT NULL, month TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS pass_completions_month ON pass_completions (month, phone)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pass_points (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL," +
      " at TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS pass_points_phone ON pass_points (phone, kind)"),
    /* one row per game play or scratch card; each one uses up one stamped order */
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pass_plays (id TEXT PRIMARY KEY, phone TEXT NOT NULL, visit_id INTEGER NOT NULL," +
      " kind TEXT NOT NULL, game TEXT, started TEXT NOT NULL, finished TEXT, score INTEGER, points INTEGER, UNIQUE (visit_id, kind))")
  ]);
  /* 13 Oct: start the Pass Card over. Every customer and all their history goes,
     once; the truck QR scan counter (pass_scans) and the team logins stay. */
  if (!(await env.DB.prepare("SELECT 1 AS x FROM meta WHERE k = 'pass-wipe:2026-10-13'").first())) {
    const tables = ["pass_customers", "pass_visits", "pass_redeems", "pass_completions", "pass_points", "pass_plays"];
    await env.DB.batch(tables.map((t) => env.DB.prepare("DELETE FROM " + t))
      .concat([env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('pass-wipe:2026-10-13', ?)").bind(new Date().toISOString())]));
  }
  /* once: cards deleted by customers before 14 Oct left their points, games and history behind */
  if (!(await env.DB.prepare("SELECT 1 AS x FROM meta WHERE k = 'pass-orphans:2026-10-14'").first())) {
    await env.DB.batch(["pass_visits", "pass_redeems", "pass_completions", "pass_points", "pass_plays"]
      .map((t) => env.DB.prepare("DELETE FROM " + t + " WHERE phone NOT IN (SELECT phone FROM pass_customers)"))
      .concat([env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('pass-orphans:2026-10-14', ?)").bind(new Date().toISOString())]));
  }
  /* 16 Oct: everything so far was a test. Start over once: every customer and
     all their history, the QR scan counters and the scan log. Team logins and
     the stock stay. Last night's backup row is kept for 30 nights. */
  if (!(await env.DB.prepare("SELECT 1 AS x FROM meta WHERE k = 'pass-wipe:2026-10-16'").first())) {
    const tables = ["pass_customers", "pass_visits", "pass_redeems", "pass_completions", "pass_points", "pass_plays", "pass_scans", "pass_scan_log"];
    await env.DB.batch(tables.map((t) => env.DB.prepare("DELETE FROM " + t))
      .concat([env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('pass-wipe:2026-10-16', ?)").bind(new Date().toISOString())]));
  }
  /* added after launch: lets a customer keep their name off Top Smashers */
  try { await env.DB.prepare("ALTER TABLE pass_customers ADD COLUMN board_hide INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { /* already there */ }
  /* added later: a game's own score (Crack the Brûlée is out of 1000), for personal records */
  try { await env.DB.prepare("ALTER TABLE pass_plays ADD COLUMN raw INTEGER").run(); } catch (e) { /* already there */ }
  /* added later: the phone (browser) a card was made on, so one phone makes one card */
  try { await env.DB.prepare("ALTER TABLE pass_customers ADD COLUMN device TEXT").run(); } catch (e) { /* already there */ }
  /* added later: 1 = the customer turned off order emails */
  try { await env.DB.prepare("ALTER TABLE pass_customers ADD COLUMN no_order_email INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { /* already there */ }
  for (const col of ["device TEXT", "browser TEXT", "joined INTEGER NOT NULL DEFAULT 0"]) {
    try { await env.DB.prepare("ALTER TABLE pass_scan_log ADD COLUMN " + col).run(); } catch (e) { /* already there */ }
  }
  readyDone = true;
}

/* Countries the sign-up picker offers: [ISO, name, dial code, min, max digits after the code].
   Dial codes are prefix-free, so a full number always splits one way. UAE first. */
export const COUNTRIES = [
  ["AE", "UAE", "971", 9, 9], ["SA", "Saudi Arabia", "966", 9, 9], ["KW", "Kuwait", "965", 8, 8],
  ["QA", "Qatar", "974", 8, 8], ["BH", "Bahrain", "973", 8, 8], ["OM", "Oman", "968", 8, 8],
  ["EG", "Egypt", "20", 10, 10], ["JO", "Jordan", "962", 9, 9], ["LB", "Lebanon", "961", 7, 8],
  ["SY", "Syria", "963", 9, 9], ["IQ", "Iraq", "964", 10, 10], ["PS", "Palestine", "970", 9, 9],
  ["YE", "Yemen", "967", 9, 9], ["SD", "Sudan", "249", 9, 9], ["MA", "Morocco", "212", 9, 9],
  ["DZ", "Algeria", "213", 9, 9], ["TN", "Tunisia", "216", 8, 8], ["LY", "Libya", "218", 9, 9],
  ["IN", "India", "91", 10, 10], ["PK", "Pakistan", "92", 10, 10], ["BD", "Bangladesh", "880", 10, 10],
  ["LK", "Sri Lanka", "94", 9, 9], ["NP", "Nepal", "977", 10, 10], ["PH", "Philippines", "63", 10, 10],
  ["ID", "Indonesia", "62", 9, 12], ["CN", "China", "86", 11, 11], ["IR", "Iran", "98", 10, 10],
  ["TR", "Turkey", "90", 10, 10], ["RU", "Russia", "7", 10, 10], ["GB", "United Kingdom", "44", 10, 10],
  ["US", "USA / Canada", "1", 10, 10], ["FR", "France", "33", 9, 9], ["DE", "Germany", "49", 10, 11],
  ["IT", "Italy", "39", 9, 10], ["ES", "Spain", "34", 9, 9], ["NL", "Netherlands", "31", 9, 9],
  ["AU", "Australia", "61", 9, 9], ["ZA", "South Africa", "27", 9, 9], ["NG", "Nigeria", "234", 10, 10],
  ["KE", "Kenya", "254", 9, 9], ["ET", "Ethiopia", "251", 9, 9]
];
/* Stored key: UAE stays "05XXXXXXXX" (the cards made before the picker), every
   other country is "00" + dial code + number. Accepts +971…, 00971…, 971…, 05… */
export function normPhone(s) {
  const raw = String(s || "").trim();
  let d = raw.replace(/\D/g, "");
  let intl = raw.startsWith("+") || d.startsWith("00");
  if (d.startsWith("00")) d = d.slice(2);
  if (!intl && d.startsWith("971") && d.length >= 11) intl = true;
  if (!intl) return d.length === 9 && d.startsWith("5") ? "0" + d : d;
  const c = COUNTRIES.find((x) => d.startsWith(x[2]));
  if (!c) return "00" + d;
  const nat = d.slice(c[2].length).replace(/^0/, "");
  return c[2] === "971" ? "0" + nat : "00" + c[2] + nat;
}
const validPhone = (p) => {
  if (/^05\d{8}$/.test(p)) return true;
  const m = /^00(\d+)$/.exec(p); if (!m) return false;
  const c = COUNTRIES.find((x) => m[1].startsWith(x[2]));
  const n = c ? m[1].length - c[2].length : 0;
  return !!c && c[2] !== "971" && n >= c[3] && n <= c[4];
};
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
/* What kind of phone scanned the QR, from the browser's user-agent string: no personal data. */
export function deviceOf(ua) {
  const u = String(ua);
  const device = /iPhone/i.test(u) ? "iPhone" : /iPad/i.test(u) ? "iPad" : /Android/i.test(u) ? "Android" : /Windows|Macintosh|Linux/i.test(u) ? "Computer" : "Other";
  const browser = /Instagram/i.test(u) ? "Instagram" : /FBAN|FBAV/i.test(u) ? "Facebook" : /Snapchat/i.test(u) ? "Snapchat" : /TikTok/i.test(u) ? "TikTok" : /WhatsApp/i.test(u) ? "WhatsApp"
    : /SamsungBrowser/i.test(u) ? "Samsung" : /CriOS|Chrome/i.test(u) ? "Chrome" : /Safari/i.test(u) ? "Safari" : "Other";
  return { device, browser };
}
const dubaiDay = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
const dubaiMonth = (offset = 0) => { const t = new Date(Date.now() + 4 * 3600e3); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() + offset); return t.toISOString().slice(0, 7); };
export const PRIZE_MIN = 3;   // Top Smashers: #1 needs at least this many cards finished in the month
/* A card's count is a running balance: it keeps going past 9 and a free item takes 9 off,
   so stamps carry over and a full card starts a new one straight away. */
function filled(card, phone, before, added) {
  const n = Math.floor((before + added) / NEED) - Math.floor(before / NEED);
  return Array.from({ length: Math.max(0, n) }, () => [phone, card]);
}

/** Everything the Pass Card needs from the stock worker, passed in to avoid a circular import. */
export async function handlePass(request, env, path, d) {
  await ensureTables(env);
  const secret = await d.sessionSecret(env);
  const pinOf = (phone, pin) => d.hmac(secret, "pin:" + phone + ":" + pin);
  const cardCode = async (phone) => phone + "-" + (await d.hmac(secret, "card:" + phone)).slice(0, 10);
  const fromCode = async (code) => {
    const m = /^(05\d{8}|00\d{8,16})-([0-9a-f]{10})$/.exec(String(code || "").trim());
    if (!m) return null;
    return d.sameString(m[2], (await d.hmac(secret, "card:" + m[1])).slice(0, 10)) ? m[1] : null;
  };
  const issue = async (phone) => {
    const exp = Math.floor(Date.now() / 1000) + PC_DAYS * 86400;
    const sig = await d.hmac(secret, "pc:" + phone + "." + exp);
    return "pc=" + encodeURIComponent(phone + "." + exp + "." + sig) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + PC_DAYS * 86400;
  };
  const customerId = async () => {
    const raw = d.cookies(request).pc;
    if (!raw) return null;
    const [phone, exp, sig] = raw.split(".");
    if (!phone || !/^\d+$/.test(exp || "") || Number(exp) * 1000 < Date.now()) return null;
    return d.sameString(sig, await d.hmac(secret, "pc:" + phone + "." + exp)) ? phone : null;
  };
  const staff = async () => {
    const board = await d.loadBoard(env);
    return d.whoAmI(request, env, board.state);
  };
  const get = (phone) => env.DB.prepare("SELECT * FROM pass_customers WHERE phone = ?").bind(phone).first();
  const body = async () => (request.method === "POST" ? await request.json().catch(() => ({})) : {});
  const pub = (c) => c && ({ phone: c.phone, first: c.first, last: c.last, email: c.email || "", offers: !!c.offers,
    burger: c.burger, dessert: c.dessert, bonus: !!c.bonus, joined: c.joined, surprise: c.surprise || null });
  const completion = (phone, card) => env.DB.prepare("INSERT INTO pass_completions (phone, card, at, month) VALUES (?, ?, ?, ?)")
    .bind(phone, card, new Date().toISOString(), dubaiMonth());
  const pointsRow = (phone, delta, kind, note) => env.DB.prepare("INSERT INTO pass_points (phone, at, delta, kind, note) VALUES (?, ?, ?, ?, ?)")
    .bind(phone, new Date().toISOString(), delta, kind, note || null);
  const balance = async (phone) => ((await env.DB.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM pass_points WHERE phone = ?").bind(phone).first()) || {}).n || 0;
  /* stamped orders from the last 48h that haven't been used for this kind of play yet, oldest first */
  const tokens = async (phone, kind) => ((await env.DB.prepare(
    "SELECT v.id FROM pass_visits v LEFT JOIN pass_plays p ON p.visit_id = v.id AND p.kind = ?" +
    " WHERE v.phone = ? AND v.at >= ? AND p.id IS NULL" +
    /* scratch cards start from the second order: the first order already brings the welcome surprise */
    (kind === "scratch" ? " AND v.id != (SELECT MIN(id) FROM pass_visits WHERE phone = v.phone)" : "") + " ORDER BY v.at ASC")
    .bind(kind, phone, new Date(Date.now() - TOKEN_HOURS * 3600e3).toISOString()).all()).results || []).map((x) => x.id);
  const OPEN_HOURS = 2;
  const openPlay = (phone) => env.DB.prepare("SELECT id FROM pass_plays WHERE phone = ? AND kind LIKE 'game%' AND finished IS NULL AND started >= ? ORDER BY started DESC LIMIT 1")
    .bind(phone, new Date(Date.now() - OPEN_HOURS * 3600e3).toISOString()).first();
  /* game window: the latest stamped order opens the games for GAME_WINDOW_MIN minutes, unlimited plays */
  const gameWindow = async (phone) => {
    const v = await env.DB.prepare("SELECT id, at FROM pass_visits WHERE phone = ? ORDER BY at DESC LIMIT 1").bind(phone).first();
    if (!v) return null;
    const until = Date.parse(v.at) + GAME_WINDOW_MIN * 60e3;
    return until > Date.now() ? { visit: v.id, until: new Date(until).toISOString() } : null;
  };
  const playId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, "0")).join("");
  /* achievements: each pays out once, recorded as a points row "ach:<id>" */
  const award = async (phone, ids) => {
    const got = new Set(((await env.DB.prepare("SELECT kind FROM pass_points WHERE phone = ? AND kind LIKE 'ach:%'").bind(phone).all()).results || []).map((x) => x.kind.slice(4)));
    const fresh = ACHIEVEMENTS.filter((a) => ids.includes(a.id) && !got.has(a.id));
    if (fresh.length) await env.DB.batch(fresh.map((a) => pointsRow(phone, a.pts, "ach:" + a.id, a.name)));
    return fresh.map((a) => a.id);
  };
  const checkOrderAchievements = async (phone) => {
    const vs = ((await env.DB.prepare("SELECT at, items FROM pass_visits WHERE phone = ?").bind(phone).all()).results || []);
    const ids = [];
    if (vs.length) ids.push("first_order");
    const tried = new Set(); vs.forEach((v) => Object.keys(JSON.parse(v.items || "{}")).forEach((k) => tried.add(k)));
    if (["ss", "brownie", "cb"].every((k) => tried.has(k))) ids.push("all_desserts");
    const month = dubaiMonth();
    if (vs.filter((v) => new Date(Date.parse(v.at) + 4 * 3600e3).toISOString().slice(0, 7) === month).length >= 5) ids.push("regular_month");
    if (await env.DB.prepare("SELECT 1 AS x FROM pass_completions WHERE phone = ? LIMIT 1").bind(phone).first()) ids.push("first_card");
    return award(phone, ids);
  };
  /* the card plus its counters: cards finished ever (fan level) and this month (Top Smashers) */
  const withStats = async (c) => {
    if (!c) return c;
    const r = await env.DB.prepare("SELECT card, month, COUNT(*) AS n FROM pass_completions WHERE phone = ? GROUP BY card, month").bind(c.phone).all();
    const done = { burger: 0, dessert: 0 }; let month = 0;
    (r.results || []).forEach((x) => { done[x.card] = (done[x.card] || 0) + x.n; if (x.month === dubaiMonth()) month += x.n; });
    const records = {};
    ((await env.DB.prepare("SELECT game, MAX(raw) AS r FROM pass_plays WHERE phone = ? AND raw IS NOT NULL GROUP BY game").bind(c.phone).all()).results || [])
      .forEach((x) => { if (x.r) records[x.game] = x.r; });
    const ach = ((await env.DB.prepare("SELECT kind FROM pass_points WHERE phone = ? AND kind LIKE 'ach:%'").bind(c.phone).all()).results || []).map((x) => x.kind.slice(4));
    return { ...pub(c), done, doneMonth: month, boardHide: !!c.board_hide, points: await balance(c.phone), records,
      gamesUntil: ((await gameWindow(c.phone)) || {}).until || null, gameWindowMin: GAME_WINDOW_MIN, scratchLeft: (await tokens(c.phone, "scratch")).length, achievements: ach };
  };
  /* Top Smashers: cards finished this month, ties go to whoever got there first.
     Public rows carry first name + last initial only. */
  const board = async (month, limit) => {
    const r = await env.DB.prepare(
      "SELECT p.phone, c.first, c.last, COUNT(*) AS n, MAX(p.at) AS reached FROM pass_completions p" +
      " JOIN pass_customers c ON c.phone = p.phone WHERE p.month = ? AND c.board_hide = 0" +
      " GROUP BY p.phone ORDER BY n DESC, reached ASC LIMIT ?").bind(month, limit).all();
    return r.results || [];
  };
  const shortName = (x) => x.first + " " + String(x.last || "").charAt(0).toUpperCase() + ".";
  const fail = (error, status = 400) => d.json({ ok: false, error }, status);
  const ok = (x, headers) => d.json({ ok: true, ...x }, 200, headers);

  /* ---- the truck poster: count every scan, then open the card page ---- */
  if (path === "/t" || path === "/scan") {
    const src = path === "/t" ? "truck" : "scan";
    await env.DB.prepare("INSERT INTO pass_scans (day, src, n) VALUES (?, ?, 1) ON CONFLICT(day, src) DO UPDATE SET n = n + 1")
      .bind(dubaiDay(), src).run();
    const dev = deviceOf(request.headers.get("user-agent") || "");
    const ins = await env.DB.prepare("INSERT INTO pass_scan_log (at, src, device, browser) VALUES (?, ?, ?, ?)")
      .bind(new Date().toISOString(), src, dev.device, dev.browser).run();   /* every scan with its time and the kind of phone */
    const scanId = ins.meta && ins.meta.last_row_id;
    const h = new Headers({ location: "/pass", "cache-control": "no-store" });
    /* a day-long cookie ties a later sign-up back to this scan (no personal data, just the row number) */
    if (scanId) h.append("set-cookie", "ps=" + scanId + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400");
    return new Response(null, { status: 302, headers: h });
  }

  if (path === "/api/pass/session" && request.method === "GET") {
    const phone = await customerId();
    const c = phone ? await get(phone) : null;
    const s = await staff();
    let card = null;
    if (c) {
      const visits = (await env.DB.prepare("SELECT id, at, items, burger, dessert, food, vibe FROM pass_visits WHERE phone = ? ORDER BY at DESC LIMIT 30")
        .bind(c.phone).all()).results || [];
      card = { ...(await withStats(c)), code: await cardCode(c.phone),
        visits: visits.map((v) => ({ ...v, items: JSON.parse(v.items || "{}") })),
        pending: visits[0] && visits[0].food == null ? visits[0] : null };   /* only the latest visit asks for a review */
    }
    return ok({ customer: card, staff: s ? { name: s.name, role: s.role } : null, need: NEED, menu: PASS_MENU, countries: COUNTRIES,
      rewards: REWARDS, achievements: ACHIEVEMENTS, games: GAMES, gameMax: GAME_MAX, pointsPerStamp: POINTS_PER_STAMP });
  }

  if (path === "/api/pass/qr.svg" && request.method === "GET") {
    const phone = await customerId();
    if (!phone || !(await get(phone))) return fail("signed_out", 401);
    const url = new URL(request.url), code = await cardCode(phone);
    /* the page asks for ?c=<its card code>; a phone holding an older page for someone else gets nothing */
    const want = url.searchParams.get("c");
    if (want && !d.sameString(want, code)) return fail("This QR belongs to another card. Reload the page.", 409);
    const qr = qrcode(0, "M");
    qr.addData(url.origin + "/pass/s/" + code);
    qr.make();
    /* brand colours: black squares on Smash yellow (dark on light, so every camera still reads it) */
    const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
      .replace(/fill="white"/g, 'fill="#FFD21C"').replace(/fill="black"/g, 'fill="#101010"');
    return new Response(svg, {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" }
    });
  }

  if (path === "/api/pass/join" && request.method === "POST") {
    const b = await body();
    const phone = normPhone(b.phone), first = clean(b.first, 40), last = clean(b.last, 40),
      email = clean(b.email, 120).toLowerCase(), pin = String(b.pin || "");
    if (!first || !last) return fail("Add your first and last name.");
    if (!validPhone(phone)) return fail("Check your mobile number: pick the country, then the number without the first 0.");
    if (!email) return fail("Add your email.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("That email doesn't look right.");
    if (!/^\d{4}$/.test(pin)) return fail("Your PIN needs exactly 4 digits.");
    if (b.consent !== true) return fail("Tick the box to agree, so we can keep your stamps.");
    if (await get(phone)) return fail("This number already has a Pass Card. Log in instead.", 409);
    /* one Pass Card per phone: a long-lived cookie marks the phone that made a card */
    const device = /^[a-f0-9]{24}$/.test(d.cookies(request).pd || "") ? d.cookies(request).pd : playId();
    if (await env.DB.prepare("SELECT 1 AS x FROM pass_customers WHERE device = ? LIMIT 1").bind(device).first())
      return fail("This phone already made a Pass Card. Log in with that card's number instead.", 409);
    /* one Pass Card per email too (compared without capitals or spaces) */
    if (await env.DB.prepare("SELECT 1 AS x FROM pass_customers WHERE lower(trim(email)) = ? LIMIT 1").bind(email.toLowerCase()).first())
      return fail("This email already has a Pass Card. Log in with that card's number, or use another email.", 409);
    await env.DB.prepare("INSERT INTO pass_customers (phone, first, last, email, pin, offers, joined, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(phone, first, last, email || null, await pinOf(phone, pin), b.offers === true ? 1 : 0, new Date().toISOString(), device).run();
    const res = ok({}, { "set-cookie": await issue(phone) });
    res.headers.append("set-cookie", "pd=" + device + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + 2 * 365 * 86400);
    const ps = d.cookies(request).ps;
    if (/^\d{1,12}$/.test(ps || "")) await env.DB.prepare("UPDATE pass_scan_log SET joined = 1 WHERE id = ?").bind(+ps).run();   /* this scan led to a card */
    return res;
  }

  if (path === "/api/pass/login" && request.method === "POST") {
    const b = await body();
    const phone = normPhone(b.phone), pin = String(b.pin || "");
    const c = validPhone(phone) ? await get(phone) : null;
    const given = await pinOf(phone || "0", pin);       /* hash either way, so a wrong number costs the same */
    const wrong = "That number and PIN don't match. Check both and try again.";
    if (!c) return fail(wrong, 401);
    if (c.lock_until && c.lock_until > new Date().toISOString())
      return fail("Too many wrong PINs. Try again in " + LOCK_MIN + " minutes, or ask the truck to reset it.", 429);
    if (!d.sameString(given, c.pin)) {
      const fails = (c.fails || 0) + 1;
      const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60e3).toISOString() : null;
      await env.DB.prepare("UPDATE pass_customers SET fails = ?, lock_until = ? WHERE phone = ?")
        .bind(lock ? 0 : fails, lock, phone).run();
      return fail(wrong, 401);
    }
    await env.DB.prepare("UPDATE pass_customers SET fails = 0, lock_until = NULL WHERE phone = ?").bind(phone).run();
    return ok({}, { "set-cookie": await issue(phone) });
  }

  if (path === "/api/pass/logout" && request.method === "POST") {
    return ok({}, { "set-cookie": "pc=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }

  if (path === "/api/pass/review" && request.method === "POST") {
    const phone = await customerId();
    const c = phone ? await get(phone) : null;
    if (!c) return fail("signed_out", 401);
    const b = await body();
    const food = Number(b.food), vibe = Number(b.vibe);
    if (![1, 2, 3, 4, 5].includes(food) || ![1, 2, 3, 4, 5].includes(vibe)) return fail("Pick a number for both food and atmosphere.");
    const v = await env.DB.prepare("SELECT id, food FROM pass_visits WHERE phone = ? ORDER BY at DESC LIMIT 1").bind(phone).first();
    if (!v || v.food != null) return fail("There's no visit waiting for a review.");
    const stmts = [env.DB.prepare("UPDATE pass_visits SET food = ?, vibe = ?, comment = ?, reviewed_at = ? WHERE id = ?")
      .bind(food, vibe, clean(b.comment, 500) || null, new Date().toISOString(), v.id)];
    let bonus = null;
    if (!c.bonus) {
      bonus = b.card === "dessert" ? "dessert" : "burger";
      stmts.push(env.DB.prepare("UPDATE pass_customers SET bonus = 1, " + bonus + " = " + bonus + " + 1 WHERE phone = ? AND bonus = 0").bind(phone));
      filled(bonus, phone, c[bonus], 1).forEach(([p, k]) => stmts.push(completion(p, k)));
    }
    await env.DB.batch(stmts);
    const earned = await award(phone, ["first_review"].concat(c.bonus ? [] : []));
    await checkOrderAchievements(phone);   /* the bonus stamp can finish a card */
    return ok({ bonus, achievements: earned });
  }

  /* customers can't delete their own card any more: they email smashandpassdxb@gmail.com and the admin does it */
  if (path === "/api/pass/delete") return fail("To delete your Pass Card, email smashandpassdxb@gmail.com.", 403);

  /* ---------------- staff (the stock app's own logins) ---------------- */
  if (path === "/api/pass/board" && request.method === "GET") {
    const phone = await customerId(), s = await staff();
    if (!phone && !s) return fail("signed_out", 401);
    const month = dubaiMonth(), rows = await board(month, 50);
    const top = rows.slice(0, 10).map((x, i) => ({ rank: i + 1, name: shortName(x), n: x.n, you: x.phone === phone }));
    const mine = phone ? rows.findIndex((x) => x.phone === phone) : -1;
    const out = { month, prizeMin: PRIZE_MIN, top, me: mine >= 0 ? { rank: mine + 1, n: rows[mine].n } : null, games: {} };
    /* game leaderboards: each customer's best score per game this month (Crack the Brûlée out of 1000) */
    const from = month + "-01T00:00:00.000Z", gtop = (await env.DB.prepare(
      "SELECT p.game, p.phone, c.first, c.last, MAX(CASE WHEN p.game = 'crack' THEN p.raw ELSE p.score END) AS best FROM pass_plays p" +
      " JOIN pass_customers c ON c.phone = p.phone WHERE p.kind LIKE 'game%' AND p.finished >= ? AND c.board_hide = 0 AND p.score > 0" +
      " GROUP BY p.game, p.phone ORDER BY best DESC").bind(new Date(Date.parse(from) - 4 * 3600e3).toISOString()).all()).results || [];
    GAMES.forEach((g) => { out.games[g] = gtop.filter((x) => x.game === g).slice(0, 5).map((x, i) => ({ rank: i + 1, name: shortName(x), score: x.best, you: x.phone === phone })); });
    if (s) {   /* the crew needs to know who to reward: last month's #1, with a number to call */
      const last = (await board(dubaiMonth(-1), 1))[0];
      out.lastWinner = last && last.n >= PRIZE_MIN ? { month: dubaiMonth(-1), name: last.first + " " + last.last, phone: last.phone, n: last.n } : null;
      out.leader = rows[0] && rows[0].n >= PRIZE_MIN ? { name: rows[0].first + " " + rows[0].last, phone: rows[0].phone, n: rows[0].n } : null;
    }
    return ok(out);
  }

  /* the "Stop order emails" link in every order email */
  if (path === "/api/pass/unsub" && request.method === "GET") {
    const u = new URL(request.url), phone = normPhone(u.searchParams.get("p") || "");
    const good = validPhone(phone) && d.sameString(u.searchParams.get("t") || "", (await d.hmac(secret, "unsub:" + phone)).slice(0, 24));
    if (good) await env.DB.prepare("UPDATE pass_customers SET no_order_email = 1 WHERE phone = ?").bind(phone).run();
    return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial,sans-serif;background:#101010;color:#FFF9EE;padding:32px">' +
      (good ? "<h2 style=\"color:#FFD21C\">Done</h2><p>You won't get order emails any more. Your Pass Card works exactly the same.</p>"
        : "<h2>That link didn't work</h2><p>Ask at the truck window and we'll turn order emails off for you.</p>") + "</body>",
      { status: good ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (path === "/api/pass/game/start" && request.method === "POST") {
    const phone = await customerId();
    if (!phone) return fail("signed_out", 401);
    const b = await body();
    if (!GAMES.includes(b.game)) return fail("Pick a game.");
    /* a game started but never finished (the reply got lost, the phone went offline)
       is picked up again instead of using another order */
    const open = await openPlay(phone);
    if (open) {
      await env.DB.prepare("UPDATE pass_plays SET game = ?, started = ? WHERE id = ? AND finished IS NULL").bind(b.game, new Date().toISOString(), open.id).run();
      return ok({ play: open.id, resumed: true });
    }
    const w = await gameWindow(phone);
    if (!w) return fail("Games open for " + GAME_WINDOW_MIN + " minutes after your next order. Show your QR at the window.", 409);
    const used = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM pass_plays WHERE visit_id = ? AND kind LIKE 'game%'").bind(w.visit).first()) || {}).n || 0;
    const id = playId();
    try {
      await env.DB.prepare("INSERT INTO pass_plays (id, phone, visit_id, kind, game, started) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, phone, w.visit, used ? "game:" + (used + 1) + ":" + id.slice(0, 6) : "game", b.game, new Date().toISOString()).run();
    } catch (e) { return fail("Tap the game again.", 409); }   /* two taps at once */
    return ok({ play: id });
  }

  if (path === "/api/pass/game/finish" && request.method === "POST") {
    const phone = await customerId();
    if (!phone) return fail("signed_out", 401);
    const b = await body();
    const p = await env.DB.prepare("SELECT * FROM pass_plays WHERE id = ? AND phone = ? AND kind LIKE 'game%' AND finished IS NULL").bind(String(b.play || ""), phone).first();
    if (!p) return fail("That game is already over.", 409);
    /* every game takes a while (Crack the Brûlée is 3 x 15 s); a faster finish is a replayed request, not a game */
    const quick = Date.now() - Date.parse(p.started) < (p.game === "crack" ? 40000 : 6000);
    const raw = p.game === "crack" ? (quick ? 0 : Math.max(0, Math.min(1000, Math.round(Number(b.raw) || 0)))) : null;
    const score = quick ? 0 : raw != null ? Math.round(raw / 10) : Math.max(0, Math.min(100, Math.round(Number(b.score) || 0)));
    const before = raw != null ? ((await env.DB.prepare("SELECT MAX(raw) AS r FROM pass_plays WHERE phone = ? AND game = ?").bind(phone, p.game).first()) || {}).r || 0 : 0;
    /* the first real game of an order earns the points; every other game is for fun and the leaderboard */
    const paid = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM pass_plays WHERE visit_id = ? AND kind LIKE 'game%' AND points > 0").bind(p.visit_id).first()) || {}).n || 0;
    const pts = quick || paid ? 0 : GAME_MAX;
    const now = new Date().toISOString();
    const res = await env.DB.prepare("UPDATE pass_plays SET finished = ?, score = ?, points = ?, raw = ? WHERE id = ? AND finished IS NULL").bind(now, score, pts, raw, p.id).run();
    if (!(res.meta && res.meta.changes)) return fail("That game is already over.", 409);
    const gain = pts;
    if (gain) await pointsRow(phone, gain, "game", p.game + " " + score).run();
    const earned = score >= 90 ? await award(phone, ["high_score"]) : [];
    return ok({ score, raw, points: gain, alreadyPaid: !!paid, achievements: earned, customer: await withStats(await get(phone)),
      record: raw != null ? Math.max(before, raw) : null, newRecord: raw != null && raw > 0 && raw > before });
  }

  if (path === "/api/pass/scratch" && request.method === "POST") {
    const phone = await customerId();
    if (!phone) return fail("signed_out", 401);
    const t = (await tokens(phone, "scratch"))[0];
    if (!t) return fail("Your next order brings a new scratch card.", 409);
    let roll = crypto.getRandomValues(new Uint32Array(1))[0] % 100, pts = SCRATCH[0][0];
    for (const [p, w] of SCRATCH) { if (roll < w) { pts = p; break; } roll -= w; }
    const now = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO pass_plays (id, phone, visit_id, kind, started, finished, points) VALUES (?, ?, ?, 'scratch', ?, ?, ?)").bind(playId(), phone, t, now, now, pts),
        pointsRow(phone, pts, "scratch", null)
      ]);
    } catch (e) { return fail("That scratch card is already used.", 409); }
    return ok({ points: pts, customer: await withStats(await get(phone)) });
  }

  if (path === "/api/pass/board/hide" && request.method === "POST") {
    const phone = await customerId();
    if (!phone) return fail("signed_out", 401);
    const b = await body();
    await env.DB.prepare("UPDATE pass_customers SET board_hide = ? WHERE phone = ?").bind(b.hide === true ? 1 : 0, phone).run();
    return ok({ customer: await withStats(await get(phone)) });
  }

  if (path.startsWith("/api/pass/staff/") || path === "/api/pass/owner" || path === "/api/pass/backup") {
    const me = await staff();
    if (!me) return fail("staff_only", 401);

    if (path === "/api/pass/staff/find" && request.method === "GET") {
      const q = new URL(request.url).searchParams.get("q") || "";
      const phone = (await fromCode(q)) || (validPhone(normPhone(q)) ? normPhone(q) : null);
      const c = phone ? await get(phone) : null;
      if (!c) return fail("No Pass Card with that number. Ask them to sign up with the QR on the truck.", 404);
      const last = await env.DB.prepare("SELECT at FROM pass_visits WHERE phone = ? ORDER BY at DESC LIMIT 1").bind(phone).first();
      const welcome = !c.surprise ? await pickSurprise(env, d) : null;
      return ok({ customer: await withStats(c), lastVisit: last ? last.at : null, welcome });
    }

    if (path === "/api/pass/staff/stamp" && request.method === "POST") {
      const b = await body();
      const phone = normPhone(b.phone);
      const c = validPhone(phone) ? await get(phone) : null;
      if (!c) return fail("Customer not found.", 404);
      const items = {};
      let burger = 0, dessert = 0;
      Object.entries(b.items || {}).forEach(([id, n]) => {
        const m = MENU_BY_ID.get(id), q = Math.floor(Number(n));
        if (!m || !(q >= 1 && q <= 20)) return;
        items[id] = q;
        if (m.card === "burger") burger = 1; else dessert = 1;
      });
      /* one stamp per card per order: any burgers = 1 burger stamp, any desserts = 1 dessert stamp */
      if (!burger && !dessert) return fail("Pick at least one item.");
      /* an offline stamp may be sent twice (retry after a dropped reply): its id makes the second one a no-op */
      const qid = typeof b.qid === "string" && /^[a-z0-9-]{8,40}$/.test(b.qid) ? b.qid : null;
      if (qid && await env.DB.prepare("SELECT 1 AS x FROM pass_points WHERE phone = ? AND kind = 'order' AND note LIKE ?").bind(phone, "%#" + qid).first())
        return ok({ customer: await withStats(c), added: { burger: 0, dessert: 0 }, welcome: null, completed: [], points: 0, achievements: [], duplicate: true });
      /* first visit: the welcome surprise. A dessert on its last day (or the
         day before) goes out free as a giveaway; otherwise 10% off the order. */
      let welcome = null;
      /* a stamp saved offline and sent later can't hand anything over, so it
         skips the surprise; the customer gets it on their next live visit */
      if (!c.surprise && b.offline !== true) {
        const pick = await pickSurprise(env, d);
        if (pick.kind === "dessert" && (await giftFromStock(env, d, pick.stock, me, { lotId: pick.lotId, ch: "Pass Card welcome" }))) welcome = pick;
        else welcome = { kind: "discount", label: "10% off the whole order" };
        const tag = welcome.kind === "dessert" ? "dessert:" + welcome.item : "discount10";
        await env.DB.prepare("UPDATE pass_customers SET surprise = ?, surprise_at = ? WHERE phone = ? AND surprise IS NULL")
          .bind(tag, new Date().toISOString(), phone).run();
      }
      /* an offline stamp keeps the time it was taken (up to a week back), so the sale lands on the right day */
      const now = Date.now(), t0 = b.offline === true ? Date.parse(b.at) : NaN;
      const at = new Date(t0 > now - 7 * 864e5 && t0 <= now ? t0 : now).toISOString();
      const sold = await saleToStock(env, d, items, me, at);
      const done = [...filled("burger", phone, c.burger, burger), ...filled("dessert", phone, c.dessert, dessert)];
      await env.DB.batch([
        ...done.map(([p, k]) => completion(p, k)),
        pointsRow(phone, (burger + dessert) * POINTS_PER_STAMP, "order", Object.entries(items).map(([k, n]) => n + "x " + k).join(", ") + (qid ? " #" + qid : "")),
        env.DB.prepare("UPDATE pass_customers SET burger = burger + ?, dessert = dessert + ? WHERE phone = ?").bind(burger, dessert, phone),
        env.DB.prepare("INSERT INTO pass_visits (phone, at, items, by, burger, dessert) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(phone, at, JSON.stringify(items), me.id, burger, dessert)
      ]);
      const earned = await checkOrderAchievements(phone);
      const after = await withStats(await get(phone));
      /* the customer's order email, sent after the reply so the truck never waits for it */
      const copied = mailReady(env) && c.email && !c.no_order_email && d.later;
      /* the owner's dessert alert, unless the BCC of the customer's email already tells them */
      if (!copied && sold.logged.length && mailReady(env) && env.ALERT_TO && d.later) {
        const n = sold.logged.reduce((a, x) => a + x.qty, 0);
        d.later(sendMail(env, { to: env.ALERT_TO, fromName: "Dee's Stock alerts", ...alertEmail({
          title: "🍰 " + n + " dessert" + (n === 1 ? "" : "s") + " sold",
          lines: sold.logged.map((x) => x.qty + "× " + x.name + " · " + sold.ch + " · " + dubaiTime(at) + " · Pass Card, stamped by " + me.name),
          link: new URL(request.url).origin + "/" }) }));
      }
      if (copied) {
        const origin = new URL(request.url).origin;
        const mail = orderEmail({
          first: c.first, need: NEED, card: { burger: after.burger, dessert: after.dessert }, points: after.points, gameMin: GAME_WINDOW_MIN,
          items: Object.entries(items).map(([k, n]) => n + "× " + MENU_BY_ID.get(k).name).join(", "),
          link: origin + "/pass", unsub: origin + "/api/pass/unsub?p=" + encodeURIComponent(phone) + "&t=" + (await d.hmac(secret, "unsub:" + phone)).slice(0, 24)
        });
        d.later(sendMail(env, { to: c.email, bcc: env.ALERT_TO, fromName: "Smash & Pass", ...mail }));
      }
      return ok({ customer: after, added: { burger, dessert }, welcome, completed: done.map((x) => x[1]),
        points: (burger + dessert) * POINTS_PER_STAMP, achievements: earned, stock: { logged: sold.logged, short: sold.short } });
    }

    if (path === "/api/pass/staff/redeem" && request.method === "POST") {
      const b = await body();
      const phone = normPhone(b.phone), card = b.card === "dessert" ? "dessert" : "burger";
      const m = MENU_BY_ID.get(b.item);
      if (!m || m.card !== card) return fail("Pick the free item.");
      const res = await env.DB.prepare("UPDATE pass_customers SET " + card + " = " + card + " - ? WHERE phone = ? AND " + card + " >= ?")
        .bind(NEED, phone, NEED).run();
      if (!(res.meta && res.meta.changes)) return fail("That card isn't full yet.", 409);
      let stock = null;
      if (m.stock) stock = (await giftFromStock(env, d, m.stock, me)) ? "logged" : "not_found";
      await env.DB.prepare("INSERT INTO pass_redeems (phone, at, card, item, by, stock) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(phone, new Date().toISOString(), card, m.id, me.id, stock).run();
      return ok({ customer: await withStats(await get(phone)), stock });
    }

    if (path === "/api/pass/staff/reward" && request.method === "POST") {
      const b = await body();
      const phone = normPhone(b.phone), r = REWARDS.find((x) => x.id === b.reward), m = MENU_BY_ID.get(b.item);
      if (!r || !m || m.card !== r.card) return fail("Pick the item they're taking.");
      const c = validPhone(phone) ? await get(phone) : null;
      if (!c) return fail("Customer not found.", 404);
      /* spend only if the balance covers it (checked in the same statement, so two taps can't both go through) */
      const res = await env.DB.prepare("INSERT INTO pass_points (phone, at, delta, kind, note) SELECT ?, ?, ?, 'reward', ?" +
        " WHERE (SELECT COALESCE(SUM(delta), 0) FROM pass_points WHERE phone = ?) >= ?")
        .bind(phone, new Date().toISOString(), -r.cost, r.id + ":" + m.id, phone, r.cost).run();
      if (!(res.meta && res.meta.changes)) return fail("Not enough points yet.", 409);
      let stock = null;
      if (m.stock) stock = (await giftFromStock(env, d, m.stock, me, { ch: "Pass Card points" })) ? "logged" : "not_found";
      await env.DB.prepare("INSERT INTO pass_redeems (phone, at, card, item, by, stock) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(phone, new Date().toISOString(), "points", m.id, me.id, stock).run();
      return ok({ customer: await withStats(await get(phone)), stock });
    }

    /* admin only: remove a customer completely (card, stamps, visits, free items, points, games, records) */
    /* admin: send one test email to ALERT_TO now and report exactly what Gmail answered */
    if (path === "/api/pass/staff/mailtest" && request.method === "POST") {
      if (me.role !== "admin") return fail("Only the admin can send a test email.", 403);
      const has = { SMTP_USER: !!env.SMTP_USER, SMTP_PASS: !!env.SMTP_PASS, ALERT_TO: !!env.ALERT_TO };
      if (!has.SMTP_USER || !has.SMTP_PASS || !has.ALERT_TO)
        return fail("Missing in Cloudflare: " + Object.keys(has).filter((k) => !has[k]).join(", ") + ". Add it as a Secret and deploy.");
      try {
        const sent = await sendMail(env, { to: String(env.ALERT_TO).split(/[,;]/)[0], fromName: "Smash & Pass", ...alertEmail({
          title: "✅ Test email from the Pass Card", lines: ["If you can read this, Gmail is connected.", "Sent " + dubaiTime() + " by " + me.name] }) });
        return sent ? ok({ to: String(env.ALERT_TO).split(/[,;]/)[0] }) : fail("ALERT_TO doesn't look like an email address.");
      } catch (e) {
        return fail("Gmail said: " + String(e && e.message || e).slice(0, 300));
      }
    }

    if (path === "/api/pass/staff/delete" && request.method === "POST") {
      if (me.role !== "admin") return fail("Only the admin can delete a Pass Card.", 403);
      const b = await body();
      const phone = normPhone(b.phone);
      if (!validPhone(phone) || !(await get(phone))) return fail("Customer not found.", 404);
      if (String(b.confirm || "").trim().toUpperCase() !== "DELETE") return fail('Type DELETE to confirm.');
      await env.DB.batch(["pass_visits", "pass_redeems", "pass_completions", "pass_points", "pass_plays", "pass_customers"]
        .map((t) => env.DB.prepare("DELETE FROM " + t + " WHERE phone = ?").bind(phone)));
      return ok({ deleted: phone });
    }

    if (path === "/api/pass/staff/resetpin" && request.method === "POST") {
      const b = await body();
      const phone = normPhone(b.phone), pin = String(b.pin || "");
      if (!/^\d{4}$/.test(pin)) return fail("The new PIN needs exactly 4 digits.");
      const res = await env.DB.prepare("UPDATE pass_customers SET pin = ?, fails = 0, lock_until = NULL WHERE phone = ?")
        .bind(await pinOf(phone, pin), phone).run();
      return res.meta && res.meta.changes ? ok({}) : fail("Customer not found.", 404);
    }

    if (path === "/api/pass/backup" && request.method === "GET") {
      if (me.role !== "admin") return fail("Only the admin can download a backup.", 403);
      const snap = await snapshot(env, d);
      return new Response(JSON.stringify(snap), { headers: { "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="dees-stock-backup-' + dubaiDay() + '.json"', "cache-control": "no-store" } });
    }

    if (path === "/api/pass/owner" && request.method === "GET") {
      const all = async (sql) => (await env.DB.prepare(sql).all()).results || [];
      const customers = (await all("SELECT * FROM pass_customers ORDER BY joined DESC")).map(pub);
      const visits = (await all("SELECT id, phone, at, items, burger, dessert, food, vibe, comment FROM pass_visits ORDER BY at DESC LIMIT 2000"))
        .map((v) => ({ ...v, items: JSON.parse(v.items || "{}") }));
      const redeems = await all("SELECT phone, at, card, item, stock FROM pass_redeems ORDER BY at DESC LIMIT 1000");
      const scans = await all("SELECT day, src, n FROM pass_scans ORDER BY day DESC LIMIT 400");
      const scanLog = await all("SELECT at, src, device, browser, joined FROM pass_scan_log ORDER BY id DESC LIMIT 300");
      const pts = (await all("SELECT kind, COUNT(*) AS n, SUM(delta) AS pts FROM pass_points GROUP BY kind"));
      const plays = await all("SELECT kind, game, COUNT(*) AS n, AVG(score) AS avg FROM pass_plays WHERE finished IS NOT NULL GROUP BY kind, game");
      return ok({ customers, visits, redeems, scans, scanLog, menu: PASS_MENU, need: NEED, points: pts, plays, rewards: REWARDS });
    }
  }
  return fail("not_found", 404);
}

/* Everything worth keeping, in one object: the stock board and every Pass Card table. */
export async function snapshot(env, d) {
  await ensureTables(env);
  const board = await d.loadBoard(env);
  const tables = {};
  for (const t of ["pass_customers", "pass_visits", "pass_redeems", "pass_completions", "pass_points", "pass_plays", "pass_scans", "pass_scan_log"]) {
    tables[t] = (await env.DB.prepare("SELECT * FROM " + t).all()).results || [];
  }
  return { app: "dees-stock", at: new Date().toISOString(), board: { version: board.version, state: board.state }, pass: tables };
}

/* Nightly: keep a copy of everything in the backups table, last 30 nights. */
export async function nightlyBackup(env, d) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS backups (day TEXT PRIMARY KEY, at TEXT NOT NULL, json TEXT NOT NULL)").run();
  const snap = await snapshot(env, d);
  let json = JSON.stringify(snap);
  /* a D1 row holds about 2 MB; if it ever outgrows that, keep the Pass Card part (Time Travel still has the rest) */
  if (json.length > 1900000) json = JSON.stringify({ ...snap, board: { version: snap.board.version, skipped: "too big for one row" } });
  await env.DB.prepare("INSERT OR REPLACE INTO backups (day, at, json) VALUES (?, ?, ?)").bind(dubaiDay(), new Date().toISOString(), json).run();
  await env.DB.prepare("DELETE FROM backups WHERE day NOT IN (SELECT day FROM backups ORDER BY day DESC LIMIT 30)").run();
  return json.length;
}

/* A free dessert comes out of the stock as a giveaway, on the oldest open lot
   of that item that still has pieces in date. If none is found the redeem
   still stands and the truck logs it by hand. */
async function giftFromStock(env, d, itemName, me, opts) {
  opts = opts || {};
  const today = dubaiDay();
  const addDays = (ds, n) => { const t = new Date(ds + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + (+n || 0)); return t.toISOString().slice(0, 10); };
  for (let attempt = 0; attempt < 3; attempt++) {
    const board = await d.loadBoard(env);
    const st = board.state;
    const it = (st.items || []).find((i) => i.name === itemName);
    if (!it) return false;
    const closed = new Set((st.weeks || []).map((w) => w.start));
    const left = (b) => (+b.qty || 0) - (b.sales || []).reduce((a, s) => a + (+s.qty || 0), 0);
    const lot = (st.batches || [])
      .filter((b) => b.itemId === it.id && !b.voided && !closed.has(b.drop || b.id) && left(b) > 0 &&
        addDays(b.madeOn, b.shelf) >= today)
      .filter((b) => !opts.lotId || b.id === opts.lotId)
      .sort((a, b) => (a.madeOn < b.madeOn ? -1 : a.madeOn > b.madeOn ? 1 : 0))[0];
    if (!lot) return false;
    lot.sales = (lot.sales || []).concat([{ qty: 1, kind: "gift", by: me.id, at: new Date().toISOString(), on: today, ch: opts.ch || "Pass Card" }]);
    st.updatedAt = new Date().toISOString();
    if ((await d.saveBoard(env, board.version, st)) != null) return true;
  }
  return false;
}

/* A stamped order's desserts are logged as sales, so the truck doesn't log them
   twice: each piece comes off the oldest open lot of that item still in date,
   spilling into the next lot when one runs out. Anything not found in stock is
   returned so the truck can log it by hand. */
async function saleToStock(env, d, items, me, at) {
  const want = Object.entries(items).map(([id, n]) => ({ m: MENU_BY_ID.get(id), n })).filter((x) => x.m && x.m.stock);
  if (!want.length) return { logged: [], short: [] };
  const on = new Date(Date.parse(at) + 4 * 3600e3).toISOString().slice(0, 10);
  const addDays = (ds, n) => { const t = new Date(ds + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + (+n || 0)); return t.toISOString().slice(0, 10); };
  const left = (b) => (+b.qty || 0) - (b.sales || []).reduce((a, s) => a + (+s.qty || 0), 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    const board = await d.loadBoard(env);
    const st = board.state;
    const closed = new Set((st.weeks || []).map((w) => w.start));
    const ch = (Array.isArray(st.channels) && st.channels[0]) || "Window";
    const logged = [], short = [];
    want.forEach(({ m, n }) => {
      const it = (st.items || []).find((i) => i.name === m.stock);
      const lots = !it ? [] : (st.batches || [])
        .filter((b) => b.itemId === it.id && !b.voided && !closed.has(b.drop || b.id) && left(b) > 0 && addDays(b.madeOn, b.shelf) >= on)
        .sort((a, b) => (a.madeOn < b.madeOn ? -1 : a.madeOn > b.madeOn ? 1 : 0));
      let need = n;
      for (const lot of lots) {
        if (!need) break;
        const q = Math.min(need, left(lot));
        lot.sales = (lot.sales || []).concat([{ qty: q, by: me.id, at, on, ch, pass: true }]);
        need -= q;
      }
      if (n - need) logged.push({ name: m.stock, qty: n - need });
      if (need) short.push({ name: m.stock, qty: need });
    });
    if (!logged.length) return { logged, short };
    st.updatedAt = new Date().toISOString();
    if ((await d.saveBoard(env, board.version, st)) != null) return { logged, short, ch };
  }
  return { logged: [], short: want.map(({ m, n }) => ({ name: m.stock, qty: n })) };
}

/* The welcome surprise for a first visit: the dessert lot closest to its
   expiry, if one is on its last day or the day before and still has pieces;
   otherwise 10% off the whole order. Read-only: nothing is taken until the
   first order is stamped. */
async function pickSurprise(env, d) {
  const today = dubaiDay();
  const addDays = (ds, n) => { const t = new Date(ds + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + (+n || 0)); return t.toISOString().slice(0, 10); };
  const soon = addDays(today, 1);
  const st = (await d.loadBoard(env)).state;
  const closed = new Set((st.weeks || []).map((w) => w.start));
  const left = (b) => (+b.qty || 0) - (b.sales || []).reduce((a, s) => a + (+s.qty || 0), 0);
  const menuByStock = new Map(PASS_MENU.filter((m) => m.stock && !m.off).map((m) => [m.stock, m]));
  const items = new Map((st.items || []).map((i) => [i.id, i]));
  const best = (st.batches || [])
    .map((b) => ({ b, it: items.get(b.itemId), exp: addDays(b.madeOn, b.shelf) }))
    .filter((x) => x.it && menuByStock.has(x.it.name) && !x.b.voided && !closed.has(x.b.drop || x.b.id) &&
      left(x.b) > 0 && x.exp >= today && x.exp <= soon)
    .sort((x, y) => (x.exp < y.exp ? -1 : x.exp > y.exp ? 1 : 0))[0];
  if (!best) return { kind: "discount", label: "10% off the whole order" };
  const m = menuByStock.get(best.it.name);
  return { kind: "dessert", item: m.id, stock: best.it.name, lotId: best.b.id, label: "a free " + best.it.name, expires: best.exp };
}
