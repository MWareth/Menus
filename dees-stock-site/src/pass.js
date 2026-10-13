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

export const NEED = 9;
export const PASS_MENU = [
  { id: "smash", name: "Smashed burger", card: "burger", stamps: 1 },
  { id: "double", name: "Double smash", card: "burger", stamps: 1 },
  { id: "chicken", name: "Chicken burger", card: "burger", stamps: 1 },
  { id: "ss", name: "San Sebastian", card: "dessert", stamps: 1, stock: "San Sebastian" },
  { id: "brownie", name: "Brownie Bag (2 pcs)", card: "dessert", stamps: 2, stock: "Brownie Bag" },
  { id: "cb", name: "Crème Brûlée", card: "dessert", stamps: 1, stock: "Crème Brûlée" },
  { id: "lazy", name: "Lazy Cake", card: "dessert", stamps: 1, stock: "Lazy Cake" },
  { id: "pav", name: "Mini Pavlova", card: "dessert", stamps: 1, stock: "Mini Pavlova" }
];
const MENU_BY_ID = new Map(PASS_MENU.map((m) => [m.id, m]));
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
    env.DB.prepare("CREATE TABLE IF NOT EXISTS pass_scans (day TEXT NOT NULL, src TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, src))")
  ]);
  readyDone = true;
}

export function normPhone(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00971")) d = "0" + d.slice(5);
  else if (d.startsWith("971")) d = "0" + d.slice(3);
  else if (d.length === 9 && d.startsWith("5")) d = "0" + d;
  return d;
}
const validPhone = (p) => /^05\d{8}$/.test(p);
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const dubaiDay = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);

/** Everything the Pass Card needs from the stock worker, passed in to avoid a circular import. */
export async function handlePass(request, env, path, d) {
  await ensureTables(env);
  const secret = await d.sessionSecret(env);
  const pinOf = (phone, pin) => d.hmac(secret, "pin:" + phone + ":" + pin);
  const cardCode = async (phone) => phone + "-" + (await d.hmac(secret, "card:" + phone)).slice(0, 10);
  const fromCode = async (code) => {
    const m = /^(05\d{8})-([0-9a-f]{10})$/.exec(String(code || "").trim());
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
  const fail = (error, status = 400) => d.json({ ok: false, error }, status);
  const ok = (x, headers) => d.json({ ok: true, ...x }, 200, headers);

  /* ---- the truck poster: count every scan, then open the card page ---- */
  if (path === "/t" || path === "/scan") {
    const src = path === "/t" ? "truck" : "scan";
    await env.DB.prepare("INSERT INTO pass_scans (day, src, n) VALUES (?, ?, 1) ON CONFLICT(day, src) DO UPDATE SET n = n + 1")
      .bind(dubaiDay(), src).run();
    return new Response(null, { status: 302, headers: { location: "/pass", "cache-control": "no-store" } });
  }

  if (path === "/api/pass/session" && request.method === "GET") {
    const phone = await customerId();
    const c = phone ? await get(phone) : null;
    const s = await staff();
    let card = null;
    if (c) {
      const visits = (await env.DB.prepare("SELECT id, at, items, burger, dessert, food, vibe FROM pass_visits WHERE phone = ? ORDER BY at DESC LIMIT 30")
        .bind(c.phone).all()).results || [];
      card = { ...pub(c), code: await cardCode(c.phone),
        visits: visits.map((v) => ({ ...v, items: JSON.parse(v.items || "{}") })),
        pending: visits[0] && visits[0].food == null ? visits[0] : null };   /* only the latest visit asks for a review */
    }
    return ok({ customer: card, staff: s ? { name: s.name, role: s.role } : null, need: NEED, menu: PASS_MENU });
  }

  if (path === "/api/pass/qr.svg" && request.method === "GET") {
    const phone = await customerId();
    if (!phone || !(await get(phone))) return fail("signed_out", 401);
    const url = new URL(request.url);
    const qr = qrcode(0, "M");
    qr.addData(url.origin + "/pass/s/" + (await cardCode(phone)));
    qr.make();
    return new Response(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "private, max-age=3600" }
    });
  }

  if (path === "/api/pass/join" && request.method === "POST") {
    const b = await body();
    const phone = normPhone(b.phone), first = clean(b.first, 40), last = clean(b.last, 40),
      email = clean(b.email, 120), pin = String(b.pin || "");
    if (!first || !last) return fail("Add your first and last name.");
    if (!validPhone(phone)) return fail("Enter a UAE mobile number, like 050 123 4567.");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("That email doesn't look right.");
    if (!/^\d{4}$/.test(pin)) return fail("Your PIN needs exactly 4 digits.");
    if (b.consent !== true) return fail("Tick the box to agree, so we can keep your stamps.");
    if (await get(phone)) return fail("This number already has a Pass Card. Log in instead.", 409);
    await env.DB.prepare("INSERT INTO pass_customers (phone, first, last, email, pin, offers, joined) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(phone, first, last, email || null, await pinOf(phone, pin), b.offers === true ? 1 : 0, new Date().toISOString()).run();
    return ok({}, { "set-cookie": await issue(phone) });
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
    }
    await env.DB.batch(stmts);
    return ok({ bonus });
  }

  if (path === "/api/pass/delete" && request.method === "POST") {
    const phone = await customerId();
    const c = phone ? await get(phone) : null;
    if (!c) return fail("signed_out", 401);
    const b = await body();
    if (!d.sameString(await pinOf(phone, String(b.pin || "")), c.pin)) return fail("That PIN isn't right.", 401);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pass_visits WHERE phone = ?").bind(phone),
      env.DB.prepare("DELETE FROM pass_redeems WHERE phone = ?").bind(phone),
      env.DB.prepare("DELETE FROM pass_customers WHERE phone = ?").bind(phone)
    ]);
    return ok({}, { "set-cookie": "pc=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }

  /* ---------------- staff (the stock app's own logins) ---------------- */
  if (path.startsWith("/api/pass/staff/") || path === "/api/pass/owner") {
    const me = await staff();
    if (!me) return fail("staff_only", 401);

    if (path === "/api/pass/staff/find" && request.method === "GET") {
      const q = new URL(request.url).searchParams.get("q") || "";
      const phone = (await fromCode(q)) || (validPhone(normPhone(q)) ? normPhone(q) : null);
      const c = phone ? await get(phone) : null;
      if (!c) return fail("No Pass Card with that number. Ask them to sign up with the QR on the truck.", 404);
      const last = await env.DB.prepare("SELECT at FROM pass_visits WHERE phone = ? ORDER BY at DESC LIMIT 1").bind(phone).first();
      const welcome = !last && !c.surprise ? await pickSurprise(env, d) : null;
      return ok({ customer: pub(c), lastVisit: last ? last.at : null, welcome });
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
        if (m.card === "burger") burger += q * m.stamps; else dessert += q * m.stamps;
      });
      if (!burger && !dessert) return fail("Pick at least one item.");
      /* first visit: the welcome surprise. A dessert on its last day (or the
         day before) goes out free as a giveaway; otherwise 10% off the order. */
      let welcome = null;
      const before = await env.DB.prepare("SELECT 1 AS x FROM pass_visits WHERE phone = ? LIMIT 1").bind(phone).first();
      if (!before && !c.surprise) {
        const pick = await pickSurprise(env, d);
        if (pick.kind === "dessert" && (await giftFromStock(env, d, pick.stock, me, { lotId: pick.lotId, ch: "Pass Card welcome" }))) welcome = pick;
        else welcome = { kind: "discount", label: "10% off the whole order" };
        const tag = welcome.kind === "dessert" ? "dessert:" + welcome.item : "discount10";
        await env.DB.prepare("UPDATE pass_customers SET surprise = ?, surprise_at = ? WHERE phone = ? AND surprise IS NULL")
          .bind(tag, new Date().toISOString(), phone).run();
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE pass_customers SET burger = burger + ?, dessert = dessert + ? WHERE phone = ?").bind(burger, dessert, phone),
        env.DB.prepare("INSERT INTO pass_visits (phone, at, items, by, burger, dessert) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(phone, new Date().toISOString(), JSON.stringify(items), me.id, burger, dessert)
      ]);
      return ok({ customer: pub(await get(phone)), added: { burger, dessert }, welcome });
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
      return ok({ customer: pub(await get(phone)), stock });
    }

    if (path === "/api/pass/staff/resetpin" && request.method === "POST") {
      const b = await body();
      const phone = normPhone(b.phone), pin = String(b.pin || "");
      if (!/^\d{4}$/.test(pin)) return fail("The new PIN needs exactly 4 digits.");
      const res = await env.DB.prepare("UPDATE pass_customers SET pin = ?, fails = 0, lock_until = NULL WHERE phone = ?")
        .bind(await pinOf(phone, pin), phone).run();
      return res.meta && res.meta.changes ? ok({}) : fail("Customer not found.", 404);
    }

    if (path === "/api/pass/owner" && request.method === "GET") {
      const all = async (sql) => (await env.DB.prepare(sql).all()).results || [];
      const customers = (await all("SELECT * FROM pass_customers ORDER BY joined DESC")).map(pub);
      const visits = (await all("SELECT id, phone, at, items, burger, dessert, food, vibe, comment FROM pass_visits ORDER BY at DESC LIMIT 2000"))
        .map((v) => ({ ...v, items: JSON.parse(v.items || "{}") }));
      const redeems = await all("SELECT phone, at, card, item, stock FROM pass_redeems ORDER BY at DESC LIMIT 1000");
      const scans = await all("SELECT day, src, n FROM pass_scans ORDER BY day DESC LIMIT 400");
      return ok({ customers, visits, redeems, scans, menu: PASS_MENU, need: NEED });
    }
  }
  return fail("not_found", 404);
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
  const menuByStock = new Map(PASS_MENU.filter((m) => m.stock).map((m) => [m.stock, m]));
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
