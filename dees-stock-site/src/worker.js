/**
 * Dee's Stock — the server side.
 *
 * One Cloudflare Worker: static files for the app, a small JSON API, and a D1
 * database holding the whole board as one row. The board is small (a few
 * hundred movements a year) so a single JSON document beats a schema here —
 * it keeps the client and the server reading exactly the same shape.
 *
 * Two things the old artifact version could not do, and which are the reason
 * this exists:
 *   - the PIN is checked on the server, so nobody can read the hashes;
 *   - the truck never receives the recipes at all, only the cost totals.
 */

import { SEED } from "./seed.js";
import { handlePass, nightlyBackup } from "./pass.js";
import { mailReady, sendMail, alertEmail, dubaiTime } from "./mail.js";

const enc = new TextEncoder();
const DAY = 86400;
const SESSION_DAYS = 30;

/* ============ small helpers ============ */

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* the same salt the board has always used, so existing PIN hashes keep working */
const pinHash = (pin) => sha256Hex("deeserts:" + pin);

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* constant-time compare, so a wrong token cannot be found a character at a time */
function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookies(request) {
  const out = {};
  const raw = request.headers.get("cookie") || "";
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* ============ the database ============ */

async function ready(env) {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY, version INTEGER NOT NULL," +
      " json TEXT NOT NULL, updated_at TEXT NOT NULL)"
    ),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  ]);
}

/** The signing key for session cookies. Generated once, on first boot. */
async function sessionSecret(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'session_secret'").first();
  if (row && row.v) return row.v;
  const fresh = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('session_secret', ?)")
    .bind(fresh).run();
  const again = await env.DB.prepare("SELECT v FROM meta WHERE k = 'session_secret'").first();
  return (again && again.v) || fresh;
}

async function loadBoard(env) {
  const row = await env.DB.prepare("SELECT version, json FROM board WHERE id = 1").first();
  if (row) return { version: row.version, state: JSON.parse(row.json) };
  const seeded = JSON.parse(JSON.stringify(SEED));
  await env.DB.prepare(
    "INSERT OR IGNORE INTO board (id, version, json, updated_at) VALUES (1, 1, ?, ?)"
  ).bind(JSON.stringify(seeded), new Date().toISOString()).run();
  return { version: 1, state: seeded };
}

/** Compare-and-set: the write only lands if nobody else has saved meanwhile. */
async function saveBoard(env, expectedVersion, state) {
  const next = expectedVersion + 1;
  const res = await env.DB.prepare(
    "UPDATE board SET version = ?, json = ?, updated_at = ? WHERE id = 1 AND version = ?"
  ).bind(next, JSON.stringify(state), new Date().toISOString(), expectedVersion).run();
  const changed = res.meta && (res.meta.changes || res.meta.rows_written);
  return changed ? next : null;
}

/* ============ one-off repairs ============
   The seed is written to the database once and never read again, so a
   correction made to the seed afterwards never reaches a board that already
   exists. Each repair here runs exactly once per database, by name, and is
   recorded in meta so it is never applied twice. A repair only touches what
   it names: stock already sent out keeps the cost it was locked in at. */
export const REPAIRS = {
  /* 18 Oct: Lazy Cake is just "Lazy Cake", with no piece count after the name */
  "lazy-cake-plain-name": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => { if (it.name === "Lazy Cake" && /pcs|pieces/i.test(it.note || "")) { it.note = ""; changed = true; } });
    return changed;
  },
  "price-feed-token": (state) => { if (state.feedToken) return false; state.feedToken = newFeedToken(); return true; },
  /* Kiri cream cheese was costed at the retail 200 g pack (AED 12.50), which
     put a San Sebastian slice at AED 7.85. Dee's now buys the Greenhouse
     1.15 kg tub at AED 35 net, which makes the slice AED 5.44. */
  "kiri-greenhouse-tub": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => {
      if (it.name !== "San Sebastian") return;
      (it.recipe || []).forEach((r) => {
        if (/kiri/i.test(r.n || "") && +r.pp === 12.5 && +r.pq === 200) {
          r.pp = 35;
          r.pq = 1150;
          changed = true;
        }
      });
    });
    return changed;
  },
  /* The Brownie Bag is now a 2-piece pack (was 4), and it carries its own
     overhead — gas, the AED 2700 mixer spread over its bakes, and the printed
     label — of about AED 0.40 a bag, not the San Sebastian slice's 1.21.
     Stock already sent out keeps the cost it was frozen at. */
  "brownie-2pack": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => {
      if (it.name !== "Brownie Bag") return;
      if (+it.perPortion === 4) { it.perPortion = 2; changed = true; }
      if (it.overhead == null || it.overhead === "") { it.overhead = 0.4; changed = true; }
      if (it.note === "4 pcs") { it.note = "2 pcs"; changed = true; }
    });
    return changed;
  },
  /* Dee's now quotes Smash a round AED 5 a brownie bag as the cost, above the
     real make cost, so the true ingredient cost stays on the admin Recipes
     view only. Orders already locked keep the cost they went out at. */
  "brownie-charge-5": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => {
      if (it.name !== "Brownie Bag") return;
      if (it.chargeCost == null || it.chargeCost === "") { it.chargeCost = 5; changed = true; }
    });
    return changed;
  },
  /* The 2-piece Brownie Bag sells at AED 18.50 (the old 26 was for the 4-piece
     pack). Only moves the price if it is still the old 26, so a hand-edit is
     never overwritten. */
  "brownie-price-185": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => {
      if (it.name !== "Brownie Bag") return;
      if (+it.price === 26) { it.price = 18.5; changed = true; }
    });
    return changed;
  },
  /* Brownie Bag is priced at AED 13. Moves it from either earlier price it may
     be sitting at on the live board (18.50 or 16), and nothing else, so a later
     hand-edit is never overwritten. */
  "brownie-price-13": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => {
      if (it.name !== "Brownie Bag") return;
      if (+it.price === 18.5 || +it.price === 16) { it.price = 13; changed = true; }
    });
    return changed;
  },
  /* Every item now keeps 3 days, not 2 — a batch baked today is good for three
     days, expiring on the third. Sets every item and the default to 3, and
     extends any lot still in date so the stock already on the truck gets the
     extra day too. Expired lots and history are left exactly as they were. */
  "shelf-3-days": (state) => {
    let changed = false;
    const addDays = (ds, n) => {
      const d = new Date(String(ds) + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const today = new Date().toISOString().slice(0, 10);
    (state.items || []).forEach((it) => {
      if (+it.shelf !== 3) { it.shelf = 3; changed = true; }
    });
    if (+state.defaultShelf !== 3) { state.defaultShelf = 3; changed = true; }
    (state.batches || []).forEach((b) => {
      if (b.voided || b.madeOn == null || b.shelf == null) return;
      /* only touch a lot that has not expired yet under its current shelf */
      if (+b.shelf < 3 && addDays(b.madeOn, +b.shelf) >= today) { b.shelf = 3; changed = true; }
    });
    return changed;
  },
  /* The 25 Sep drop (7 San Sebastian + 11 Brownie Bags) was locked with the
     delivery typed above AED 51 to recover the cutting loss. Dee's chose to
     absorb it instead, so put that drop's delivery back to 51. The delivery
     is baked into each lot's frozen cost, so work out what was spread from the
     brownie lot (its cost minus the AED 5 charge) and take the excess back off
     every lot in the drop. Sales on the lots are left untouched. Does nothing
     unless exactly one drop matches and the numbers look like that order. */
  "drop-25sep-delivery-51": (state) => {
    const items = new Map((state.items || []).map((it) => [it.id, it]));
    const nameOf = (b) => ((items.get(b.itemId) || {}).name || "");
    const drops = new Map();
    (state.batches || []).forEach((b) => {
      if (b.voided || !b.drop) return;
      if (!["2026-09-24", "2026-09-25", "2026-09-26"].includes(b.madeOn)) return;
      if (!drops.has(b.drop)) drops.set(b.drop, []);
      drops.get(b.drop).push(b);
    });
    const matches = [...drops.values()].filter((lots) => {
      const costed = lots.filter((b) => b.unitCost != null);
      if (costed.length !== 2) return false;
      const ss = costed.find((b) => nameOf(b) === "San Sebastian");
      const br = costed.find((b) => nameOf(b) === "Brownie Bag");
      return ss && br && +ss.qty === 7 && +br.qty === 11;
    });
    if (matches.length !== 1) return false;
    const lots = matches[0].filter((b) => b.unitCost != null);
    const br = lots.find((b) => nameOf(b) === "Brownie Bag");
    const ss = lots.find((b) => nameOf(b) === "San Sebastian");
    const brItem = items.get(br.itemId) || {};
    if (brItem.chargeCost == null || brItem.chargeCost === "") return false;
    const pieces = lots.reduce((a, b) => a + (+b.qty || 0), 0);   // 18
    const perNow = +br.unitCost - (+brItem.chargeCost);             // delivery per piece as locked
    const perWant = 51 / pieces;
    /* only act if the delivery really was above 51, and by a believable amount */
    if (!(perNow > perWant + 0.005) || perNow * pieces > 150) return false;
    const ssBase = +ss.unitCost - perNow;                           // should be ~5.44
    if (!(ssBase > 4 && ssBase < 7)) return false;
    const delta = perNow - perWant;
    lots.forEach((b) => { b.unitCost = +b.unitCost - delta; });
    return true;
  },
  /* Every item carries a "cost we charge Smash" that covers its true cost —
     ingredients, packaging and Dee's own overhead — rounded up to the next
     whole dirham, the way the Brownie Bag's AED 5 does. Worked out from the
     recipe as it stands on the board. Only fills items that have no charge
     yet, so a number Dee's typed in is never replaced, and orders already
     locked keep the cost they went out at. */
  "charge-covers-true-cost": (state) => {
    let changed = false;
    const shop = state.overheadPerPiece != null ? (+state.overheadPerPiece || 0) : 1.21;
    (state.items || []).forEach((it) => {
      if (it.chargeCost != null && it.chargeCost !== "") return;
      const recipe = it.recipe || [];
      const y = +it.yieldPieces || 0, p = +it.perPortion || 1;
      const portions = y > 0 && p > 0 ? Math.floor(y / p) : 0;
      if (!recipe.length || !portions) return;
      const batch = recipe.reduce((a, r) => {
        const q = +r.q, pq = +r.pq, pp = +r.pp;
        return a + (pq > 0 && !isNaN(q) && !isNaN(pp) ? (q / pq) * pp : 0);
      }, 0);
      const overhead = it.overhead != null && it.overhead !== "" ? (+it.overhead || 0) : shop;
      const trueCost = batch / portions + (+it.packaging || 0) + overhead;
      if (!(trueCost > 0)) return;
      it.chargeCost = Math.ceil(trueCost - 1e-9);
      changed = true;
    });
    return changed;
  },
  /* The 1 Oct drop (8 San Sebastian + 17 Brownie Bags) goes out on 2 Oct,
     matching its stickers (made 2 Oct, expires 5 Oct). Moves only that
     drop's send-out date, the way CHANGE DATE does: anything logged before
     2 Oct moves up to it. Costs and prices are untouched. Does nothing
     unless exactly one open drop matches. */
  "drop-1oct-to-2oct": (state) => {
    const items = new Map((state.items || []).map((it) => [it.id, it]));
    const nameOf = (b) => ((items.get(b.itemId) || {}).name || "");
    const closed = new Set((state.weeks || []).map((w) => w.start));
    const drops = new Map();
    (state.batches || []).forEach((b) => {
      if (b.voided || !b.drop || b.madeOn !== "2026-10-01") return;
      if (!drops.has(b.drop)) drops.set(b.drop, []);
      drops.get(b.drop).push(b);
    });
    const matches = [...drops.entries()].filter(([key, lots]) => {
      if (closed.has(key)) return false;
      const ss = lots.find((b) => nameOf(b) === "San Sebastian");
      const br = lots.find((b) => nameOf(b) === "Brownie Bag");
      return lots.length === 2 && ss && br && +ss.qty === 8 && +br.qty === 17;
    });
    if (matches.length !== 1) return false;
    const nd = "2026-10-02";
    matches[0][1].forEach((b) => {
      b.madeOn = nd;
      (b.sales || []).forEach((s) => {
        const on = s.on || (s.at || "").slice(0, 10);
        if (on && on < nd) s.on = nd;
      });
    });
    return true;
  },
  /* Vanilla is bought as a pack at AED 5, and every recipe uses one pack a
     batch. The San Sebastian card had been changed to a 1-piece pack while
     still using "20", which costed AED 100 of vanilla per cake and showed a
     26% margin. Every vanilla line now reads 1 pack at AED 5. Only recipe
     cards change: orders already sent keep the cost they went out at. */
  "vanilla-one-pack-5": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => {
      (it.recipe || []).forEach((r) => {
        if (!/vanil/i.test(r.n || "")) return;
        if (+r.q === 1 && r.u === "pack" && +r.pp === 5 && +r.pq === 1) return;
        r.q = 1; r.u = "pack"; r.pp = 5; r.pq = 1;
        changed = true;
      });
    });
    return changed;
  },
  /* One price for each ingredient, whichever recipe it is in. Cream is the
     Greenhouse carton (12 x 1 L for AED 264.60, so AED 22.05 a litre), Kiri is
     AED 40 for 1,100 g, and everything else the San Sebastian card shares with
     another card (eggs, sugar, flour, vanilla) takes the San Sebastian price.
     Egg yolks and whites are priced per egg. Baking sheets are left alone:
     each recipe uses a different size. Only pack price and pack size change,
     never how much a recipe uses, and only where the units match. */
  "match-prices-to-san-sebastian": (state) => {
    let changed = false;
    const set = (r, pp, pq) => {
      if (+r.pp === pp && +r.pq === pq) return;
      r.pp = pp; r.pq = pq; changed = true;
    };
    const unit = (r) => String(r.u || "").trim().toLowerCase();
    const key = (n) => {
      const s = String(n || "").trim().toLowerCase();
      return /\begg/.test(s) ? "egg" : s.replace(/s$/, "");
    };
    const items = state.items || [];
    items.forEach((it) => (it.recipe || []).forEach((r) => {
      if (!/cream/i.test(r.n || "") || /cheese|kiri/i.test(r.n || "")) return;
      const u = unit(r);
      if (u === "ml") set(r, 22.05, 1000);
      else if (["l", "ltr", "litre", "liter"].includes(u)) set(r, 22.05, 1);
    }));
    const ss = items.find((it) => it.name === "San Sebastian");
    if (!ss) return changed;
    (ss.recipe || []).forEach((r) => {
      if (/kiri/i.test(r.n || "") && unit(r) === "g") set(r, 40, 1100);
    });
    const ref = new Map();
    (ss.recipe || []).forEach((r) => {
      const k = key(r.n);
      if (!k || /cream|kiri|baking sheet/.test(k) || !(+r.pq > 0)) return;
      ref.set(k, r);
    });
    items.forEach((it) => {
      if (it === ss) return;
      (it.recipe || []).forEach((r) => {
        const src = ref.get(key(r.n));
        if (src && unit(src) === unit(r)) set(r, +src.pp, +src.pq);
      });
    });
    return changed;
  },
  /* Crème Brûlée sells at AED 23. A normal batch is 500 ml cream, 6 egg yolks,
     100 g sugar and 2 vanilla packs, and makes 6 ramekins (the 7 Oct double
     batch used twice that for 12). */
  "creme-brulee-23": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => {
      if (!/^cr[eè]me br[uû]l[eé]e$/i.test(String(it.name || "").trim())) return;
      if (+it.price !== 23) { it.price = 23; changed = true; }
      if (+it.yieldPieces !== 6) { it.yieldPieces = 6; changed = true; }
      (it.recipe || []).forEach((r) => {
        if (/yolk/i.test(r.n || "") && +r.q !== 6) { r.q = 6; changed = true; }
        if (/vanil/i.test(r.n || "") && +r.q !== 2) { r.q = 2; changed = true; }
        const u = String(r.u || "").trim().toLowerCase();
        if (/cream/i.test(r.n || "") && u === "ml" && +r.q !== 500) { r.q = 500; changed = true; }
        if (/sugar/i.test(r.n || "") && u === "g" && +r.q !== 100) { r.q = 100; changed = true; }
      });
    });
    return changed;
  },
  /* The 12 Crème Brûlées sent out on 7 Oct are samples: they sell at AED 23,
     Dee's covers their cost, and only the profit from what sells is split.
     Their share of the order's delivery fee stays charged. Does nothing
     unless exactly one open lot of 12 went out between 6 and 8 Oct; the
     SAMPLES button on the lot does the same by hand. */
  "creme-brulee-7oct-samples": (state) => {
    const isCB = (it) => /^cr[eè]me br[uû]l[eé]e$/i.test(String((it || {}).name || "").trim());
    const items = new Map((state.items || []).map((it) => [it.id, it]));
    const closed = new Set((state.weeks || []).map((w) => w.start));
    const lots = (state.batches || []).filter((b) =>
      !b.voided && !b.samples && isCB(items.get(b.itemId)) && +b.qty === 12 &&
      ["2026-10-06", "2026-10-07", "2026-10-08"].includes(b.madeOn) &&
      !closed.has(b.drop || b.id) && b.unitCost != null);
    if (lots.length !== 1) return false;
    const b = lots[0], it = items.get(b.itemId);
    const charge = it.chargeCost != null && it.chargeCost !== "" ? +it.chargeCost : null;
    const deliv = b.deliveryEach != null ? +b.deliveryEach
      : charge != null ? Math.max(0, +b.unitCost - charge) : null;
    if (deliv == null || !(deliv <= +b.unitCost)) return false;
    b.unitPrice = 23;
    b.costBeforeSamples = b.unitCost;
    b.unitCost = deliv;
    b.samples = true;
    return true;
  },
  /* Crème Brûlée ramekins: the pastel ones (AED 49 for 30, so 1.63 each) are
     the packaging behind what Smash is charged; the black-and-gold ones Dee's
     buys (AED 59.99 for 100, so 0.60 each) are the real cost on MY P&L. The
     price Smash pays per ramekin does not change. */
  "creme-brulee-ramekins": (state) => {
    let changed = false;
    (state.items || []).forEach((it) => {
      if (!/^cr[eè]me br[uû]l[eé]e$/i.test(String(it.name || "").trim())) return;
      if (+it.packaging !== 1.63) { it.packaging = 1.63; changed = true; }
      if (+it.realPackaging !== 0.6) { it.realPackaging = 0.6; changed = true; }
    });
    return changed;
  },
  /* 13 Oct: the Pass Card is starting over with no customers. Its test runs
     logged real desserts off the stock as giveaways (welcome surprise, free
     dessert, points reward), all marked "Pass Card…"; those pieces go back to
     unsold. Deliveries already closed in the settle are left as they are. */
  /* 14 Oct: Dee's new Chocolate Cake joins the stock as a slice. It goes in
     uncosted with no price; Dee fills the recipe, yield and price on the
     Recipes tab, and until then it still sells and stamps on the Pass Card. */
  "chocolate-cake-item": (state) => {
    if ((state.items || []).some((it) => /^chocolate cake$/i.test(String(it.name || "").trim()))) return false;
    state.items = state.items || [];
    state.items.push({ id: "i-choc", name: "Chocolate Cake", note: "slice", price: 0, shelf: 3, active: true,
      batchWord: "cake", portionWord: "slice", yieldPieces: 0, perPortion: 1, packaging: 0.25, recipe: [] });
    return true;
  },
  /* 14 Oct: Dee's recipe for the cake, one cake = 8 slices, sold at AED 45.
     Smash is charged AED 16 a slice (the make cost is about 13.4). Only fills
     the recipe while it is still empty, so later edits on the Recipes tab stay. */
  "chocolate-cake-recipe": (state) => {
    const it = (state.items || []).find((i) => /^chocolate cake$/i.test(String(i.name || "").trim()));
    if (!it || (it.recipe || []).length) return false;
    it.recipe = [
      { n: "Chocolate slab", q: 300, u: "g", pp: 63.13, pq: 300 },
      { n: "Butter", q: 150, u: "g", pp: 17, pq: 200 },
      { n: "Heavy cream", q: 300, u: "ml", pp: 22.05, pq: 1000 },
      { n: "Cocoa powder", q: 40, u: "g", pp: 17.25, pq: 108 },
      { n: "Oil", q: 130, u: "ml", pp: 17.25, pq: 750 },
      { n: "Flour", q: 280, u: "g", pp: 17.75, pq: 2000 },
      { n: "Vanilla", q: 2, u: "sachet", pp: 5, pq: 5 },
      { n: "Eggs", q: 2, u: "pcs", pp: 23.75, pq: 30 },
      { n: "Sugar", q: 120, u: "g", pp: 11.9, pq: 1000 },
      { n: "Milk", q: 200, u: "ml", pp: 6.75, pq: 1000 },
      { n: "Instant coffee", q: 2, u: "g", pp: 17.75, pq: 50 },
      { n: "Vinegar", q: 15, u: "ml", pp: 8.5, pq: 473 },
      { n: "Baking powder", q: 6, u: "g", pp: 10, pq: 225 },
      { n: "Hot water", q: 130, u: "ml", pp: 2, pq: 1000 },
      { n: "Salt", q: 3, u: "g", pp: 3, pq: 1000 }
    ];
    it.yieldPieces = 8; it.perPortion = 1; it.price = 45; it.chargeCost = 16; it.packaging = 0.25; it.overhead = 0.4;
    return true;
  },
  /* 17 Oct: one price per ingredient for every recipe. Built once from the
     recipes themselves: where two recipes priced the same ingredient
     differently, the recipe added last (the newest shopping) wins, and that
     price is copied into every line with that name. */
  "heavy-cream-is-cream": (state) => {
    const norm = (n) => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
    let changed = false;
    (state.items || []).forEach((it) => (it.recipe || []).forEach((r) => {
      const k = norm(r.n);
      if (k === "heavy cream" || k === "cream") { if (r.n !== "Cream" || r.pp !== 22.05 || r.pq !== 1000) changed = true; r.n = "Cream"; r.pp = 22.05; r.pq = 1000; if (!r.u) r.u = "ml"; }
    }));
    if (Array.isArray(state.pantry)) {
      const keep = state.pantry.filter((x) => { const k = norm(x.n); return k !== "heavy cream" && k !== "cream"; });
      keep.push({ n: "Cream", pp: 22.05, pq: 1000, u: "ml" });
      keep.sort((a, b) => a.n.localeCompare(b.n));
      state.pantry = keep; changed = true;
    }
    return changed;
  },
  "pantry-from-recipes": (state) => {
    if (Array.isArray(state.pantry)) return false;
    const norm = (n) => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
    const map = {};
    (state.items || []).forEach((it) => (it.recipe || []).forEach((r) => {
      const k = norm(r.n); if (!k) return;
      map[k] = { n: String(r.n).trim(), pp: +r.pp || 0, pq: +r.pq || 1, u: r.u || "" };
    }));
    state.pantry = Object.keys(map).sort().map((k) => map[k]);
    (state.items || []).forEach((it) => (it.recipe || []).forEach((r) => { const p = map[norm(r.n)]; if (p) { r.pp = p.pp; r.pq = p.pq; } }));
    return true;
  },
  /* 16 Oct: the Pass Card started over again; its test giveaways go back to unsold (same rule as 13 Oct) */
  "pass-card-test-giveaways-16oct": (state) => REPAIRS["pass-card-test-giveaways"](state),
  "pass-card-test-giveaways": (state) => {
    const closed = new Set((state.weeks || []).map((w) => w.start));
    let changed = false;
    (state.batches || []).forEach((b) => {
      if (closed.has(b.drop || b.id) || !Array.isArray(b.sales)) return;
      const keep = b.sales.filter((x) => !(x.kind === "gift" && /^Pass Card/.test(String(x.ch || ""))));
      if (keep.length !== b.sales.length) { b.sales = keep; changed = true; }
    });
    return changed;
  }
};

/** Apply every repair not yet recorded in `done`; says which ones ran and whether the board moved. */
export function applyRepairs(state, done) {
  const applied = [];
  let changed = false;
  Object.keys(REPAIRS).forEach((name) => {
    if (done.has(name)) return;
    if (REPAIRS[name](state)) changed = true;
    applied.push(name);
  });
  return { applied, changed };
}

async function repaired(env, board) {
  const rows = await env.DB.prepare("SELECT k FROM meta WHERE k LIKE 'repair:%'").all();
  const done = new Set((rows.results || []).map((r) => r.k.slice("repair:".length)));
  const next = JSON.parse(JSON.stringify(board.state));
  const { applied, changed } = applyRepairs(next, done);
  if (!applied.length) return board;
  let version = board.version;
  if (changed) {
    next.updatedAt = new Date().toISOString();
    version = await saveBoard(env, board.version, next);
    /* somebody saved first: leave it for the next request, which sees the newer board */
    if (version == null) return board;
  }
  await env.DB.batch(applied.map((name) =>
    env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)")
      .bind("repair:" + name, new Date().toISOString())
  ));
  return { version, state: changed ? next : board.state };
}

/* ============ sessions ============ */

async function issueSession(env, uid) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * DAY;
  const body = uid + "." + exp;
  const sig = await hmac(await sessionSecret(env), body);
  const value = body + "." + sig;
  return "ds=" + encodeURIComponent(value) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" +
    SESSION_DAYS * DAY;
}

async function whoAmI(request, env, state) {
  const raw = cookies(request).ds;
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return null;
  const want = await hmac(await sessionSecret(env), uid + "." + exp);
  if (!sameString(sig, want)) return null;
  return (state.team || []).find((u) => u.id === uid) || null;
}

const ROLES = {
  admin: { canDeliver: true, canSell: true, canSetup: true },
  dees: { canDeliver: true, canSell: false, canSetup: false },
  truck: { canDeliver: false, canSell: true, canSetup: false }
};
const permsOf = (u) => ROLES[u && u.role] || ROLES.truck;

/* ============ what each side is allowed to see ============ */

/**
 * The board as this person may see it. PIN hashes never leave the server. The
 * truck gets one synthetic ingredient line carrying the same total, so every
 * cost and margin on their screen is right to the fil while the recipe itself
 * stays behind.
 */
function forViewer(state, me) {
  const view = JSON.parse(JSON.stringify(state));
  if (!permsOf(me).canSetup) delete view.feedToken;   /* the share link is the admin's */
  view.team = (view.team || []).map((u) => ({ id: u.id, name: u.name, user: u.user, role: u.role }));
  if (!permsOf(me).canDeliver) {
    /* the truck sees what it pays (the price per piece frozen on each lot, and
       the delivery) and nothing that would let it work out Dee's real cost:
       no recipes, packaging, overhead, petrol or ingredient buys */
    view.items = (view.items || []).map((it) => {
      const out = { ...it, recipe: [] };
      delete out.packaging; delete out.realPackaging; delete out.overhead;
      return out;
    });
    view.batches = (view.batches || []).map((b) => {
      const out = { ...b };
      delete out.realEach; delete out.tripEach;
      return out;
    });
    delete view.overheadPerPiece; delete view.tripCost;
    view.buys = [];
    /* running costs (petrol, DEWA, gas) are Dee's own books, not part of the
       50/50 — the truck never sees them */
    view.overheads = [];
    view.shops = [];
    delete view.reports;
    view.pantry = [];
    delete view.feedUrl; delete view.feedAt; delete view.feedMatched;   /* ingredient prices are Dee's side only */
  }
  return view;
}

/**
 * Merge what the client sent onto what is stored, keeping everything that
 * person is not allowed to touch. The client never has the authority — the
 * stored copy does.
 */
function mergeSave(stored, incoming, me) {
  const perm = permsOf(me);
  const out = JSON.parse(JSON.stringify(stored));

  /* the truck may only record movements against a lot: what sold, what was
     given away, what went in the bin. Nothing else it sends is even read. */
  if (!perm.canDeliver) {
    if (!perm.canSell || !Array.isArray(incoming.batches)) return out;
    const byId = new Map(out.batches.map((b) => [b.id, b]));
    incoming.batches.forEach((b) => {
      const t = byId.get(b && b.id);
      if (t && Array.isArray(b.sales)) {
        t.sales = b.sales
          .filter((s) => s && typeof s.qty === "number" && isFinite(s.qty))
          .map((s) => ({
            qty: s.qty, by: String(s.by || me.id), at: String(s.at || new Date().toISOString()),
            on: typeof s.on === "string" ? s.on : undefined,
            ch: typeof s.ch === "string" ? s.ch : undefined,
            kind: s.kind === "gift" || s.kind === "waste" ? s.kind : undefined,
            fix: s.fix === true ? true : undefined,
            undo: s.undo === true ? true : undefined,
            revIdx: typeof s.revIdx === "number" ? s.revIdx : undefined
          }));
      }
    });
    return out;
  }

  /* Dee's side and admins may change the board itself */
  ["currency", "defaultShelf", "notify", "seq", "defaultPins", "tripCost"].forEach((k) => {
    if (incoming[k] !== undefined) out[k] = incoming[k];
  });
  if (incoming.split && typeof incoming.split === "object") out.split = incoming.split;
  if (Array.isArray(incoming.channels)) out.channels = incoming.channels;
  if (Array.isArray(incoming.items)) out.items = incoming.items;
  if (Array.isArray(incoming.batches)) out.batches = incoming.batches;
  if (Array.isArray(incoming.payments)) out.payments = incoming.payments;
  if (Array.isArray(incoming.buys)) out.buys = incoming.buys;
  if (Array.isArray(incoming.overheads)) out.overheads = incoming.overheads;
  if (perm.canSetup && Array.isArray(incoming.shops)) out.shops = incoming.shops.slice(0, 30).map((x) => ({ name: String((x && x.name) || "").slice(0, 60), url: String((x && x.url) || "").slice(0, 200), color: /^#[0-9a-f]{6}$/i.test((x && x.color) || "") ? x.color : "" })).filter((x) => x.name && /^https?:\/\//.test(x.url));
  if (perm.canSetup && typeof incoming.feedUrl === "string") out.feedUrl = feedUrlOk(incoming.feedUrl.trim()) ? incoming.feedUrl.trim() : "";
  out.selfUrl = stored.selfUrl; out.feedToken = stored.feedToken; out.feedAt = stored.feedAt; out.feedMatched = stored.feedMatched; out.reports = stored.reports;
  if (Array.isArray(incoming.pantry)) out.pantry = incoming.pantry.slice(0, 500).map((x) => ({
    n: String((x && x.n) || "").slice(0, 80), pp: Math.max(0, +(x && x.pp) || 0), pq: +(x && x.pq) > 0 ? +x.pq : 1, u: String((x && x.u) || "").slice(0, 12)
  })).filter((x) => x.n);
  if (incoming.monthsPaid && typeof incoming.monthsPaid === "object" && !Array.isArray(incoming.monthsPaid))
    out.monthsPaid = incoming.monthsPaid;
  if (incoming.monthPays && typeof incoming.monthPays === "object" && !Array.isArray(incoming.monthPays))
    out.monthPays = incoming.monthPays;

  /* the team list is admin-only, and a PIN hash is only ever accepted when the
     client actually sent a fresh one — otherwise the stored hash stands */
  if (perm.canSetup && Array.isArray(incoming.team)) {
    const old = new Map((stored.team || []).map((u) => [u.id, u]));
    out.team = incoming.team.map((u) => {
      const was = old.get(u.id);
      const fresh = typeof u.pin === "string" && /^[0-9a-f]{64}$/.test(u.pin) ? u.pin : null;
      return {
        id: u.id, name: u.name, user: u.user, role: u.role,
        pin: fresh || (was && was.pin) || SEED.defaultPinHash
      };
    });
  } else {
    out.team = stored.team;
  }
  out.updatedAt = new Date().toISOString();
  return out;
}


/* ============ the price feed ============
   One shop (Dee's Stock) is the primary pantry. It shares its ingredient prices and recipes
   at a long random link; every other shop pastes that link once and pulls it every night
   or on demand. Charges, selling prices, overheads, stock and the "shop's own" ticks stay local. */
const norm = (n) => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
function feedBody(state) {
  return { ok: true, kind: "dees-prices", at: state.updatedAt || null, pantry: state.pantry || [],
    items: (state.items || []).map((it) => ({ name: it.name, recipe: (it.recipe || []).map((r) => ({ n: r.n, q: r.q, u: r.u, pp: r.pp, pq: r.pq })),
      yieldPieces: it.yieldPieces, perPortion: it.perPortion, packaging: it.packaging, realPackaging: it.realPackaging,
      overhead: it.overhead != null && it.overhead !== "" ? +it.overhead : (state.overheadPerPiece != null ? +state.overheadPerPiece || 0 : 1.21) })) };
}
function applyFeed(state, feed) {
  const by = {}; (feed.pantry || []).forEach((r) => { if (r && r.n) by[norm(r.n)] = { n: String(r.n).trim(), pp: +r.pp || 0, pq: +r.pq > 0 ? +r.pq : 1, u: r.u || "" }; });
  state.pantry = Object.keys(by).sort().map((k) => by[k]);
  let matched = 0;
  (feed.items || []).forEach((src) => {
    const it = (state.items || []).find((x) => norm(x.name) === norm(src.name));
    if (!it) return;
    const own = new Set((it.recipe || []).filter((r) => r.own).map((r) => norm(r.n)));
    it.recipe = (src.recipe || []).map((r) => { const pan = by[norm(r.n)]; const line = { n: r.n, q: +r.q || 0, u: r.u || "", pp: pan ? pan.pp : +r.pp || 0, pq: pan ? pan.pq : (+r.pq > 0 ? +r.pq : 1) }; if (own.has(norm(r.n))) line.own = true; return line; });
    ["yieldPieces", "perPortion", "packaging", "realPackaging", "overhead"].forEach((f) => { if (src[f] != null && src[f] !== "") it[f] = src[f]; });
    matched++;
  });
  return matched;
}
const feedUrlOk = (u) => /^https:\/\/[a-z0-9.-]+(:\d+)?\/api\/feed\/[A-Za-z0-9]{24,}$/i.test(u) || /^http:\/\/localhost(:\d+)?\/api\/feed\/[A-Za-z0-9]{24,}$/.test(u);
async function pullFeed(env, origin) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const board = await loadBoard(env);
    const url = board.state.feedUrl;
    if (!url || !feedUrlOk(url)) return { ok: false, error: "no_feed" };
    let feed;
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
      feed = await r.json().catch(() => null);
      if (!r.ok || !feed || feed.kind !== "dees-prices") return { ok: false, error: r.status === 404 ? "bad_link" : "bad_feed" };
    } catch (e) { return { ok: false, error: "unreachable" }; }
    const next = JSON.parse(JSON.stringify(board.state));
    const matched = applyFeed(next, feed);
    next.feedAt = new Date().toISOString(); next.feedMatched = matched; next.updatedAt = next.feedAt;
    if (origin) next.selfUrl = origin;   /* so the nightly pull can report under this shop's address */
    if ((await saveBoard(env, board.version, next)) != null) { await reportUp(env, next, origin || next.selfUrl || ""); return { ok: true, matched, pantry: next.pantry.length, at: next.feedAt }; }
  }
  return { ok: false, error: "busy" };
}
function newFeedToken() { const a = new Uint8Array(24); crypto.getRandomValues(a); return Array.from(a, (x) => "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x % 56]).join(""); }



/* ============ shop numbers for the main dashboard ============
   A shop that follows the main dashboard's price link also reports its own numbers back
   over the same link after every save, sale or stamp, so its card on the main dashboard
   shows what is on its shelf, what sold and what it owes. No customer data travels. */
function shopSummary(state) {
  const now = new Date(Date.now() + 4 * 3600e3), today = now.toISOString().slice(0, 10), mk = today.slice(0, 7);
  const addDays = (ds, n) => { const t = new Date(ds + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + (+n || 0)); return t.toISOString().slice(0, 10); };
  const closed = new Set((state.weeks || []).map((w) => w.start));
  let onHand = 0, soldToday = 0, soldMonth = 0, toClear = 0, takings = 0, cost = 0, delivered = 0;
  (state.batches || []).forEach((b) => {
    if (b.voided) return;
    const sales = b.sales || [];
    const left = (+b.qty || 0) - sales.reduce((a, s) => a + (+s.qty || 0), 0);
    const live = !closed.has(b.drop || b.id);
    const end = b.madeOn ? addDays(b.madeOn, b.shelf) : "9999";
    if (live && left > 0) { onHand += left; if (end <= today) toClear++; }
    if ((b.madeOn || "").slice(0, 7) === mk) { delivered += +b.qty || 0; if (b.unitCost != null) cost += (+b.qty || 0) * (+b.unitCost || 0); }
    sales.forEach((s) => {
      if (s.kind && s.kind !== "sale") return;   /* gifts and waste aren't sales; an undo is a "sale" line with a minus qty, so it takes the sale back */
      const on = s.on || String(s.at || "").slice(0, 10);
      if (on === today) soldToday += +s.qty || 0;
      if (on.slice(0, 7) === mk) { soldMonth += +s.qty || 0; takings += (+s.qty || 0) * (+b.unitPrice || 0); }
    });
  });
  const ws = state.split && state.split.basis === "wholesale", d = ws ? 0 : (+((state.split || {}).deesPct) || 0) / 100;
  const owed = cost + Math.max(0, takings - cost) * d;
  const paid = ((state.monthPays || {})[mk] || []).reduce((a, p) => a + (+p.amount || 0), 0);
  return { onHand, soldToday, soldMonth, toClear, delivered, owed: Math.round((owed - paid) * 100) / 100, deal: ws ? "wholesale" : Math.round(d * 100) + "% split", month: mk };
}
async function reportUp(env, state, origin) {
  const url = state.feedUrl;
  if (!url || !feedUrlOk(url)) return;
  try {
    await fetch(url + "/report", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ url: origin, summary: shopSummary(state) }) });
  } catch (e) { /* the main dashboard is down: the next save reports again */ }
}
const shopKey = (u) => String(u || "").trim().toLowerCase().replace(/^(https?:\/\/[^/]+).*$/, "$1");

/* ============ low stock ============
   Each item can carry "warn below" (it.low). When a sale, a gift or a stamp takes an item's
   pieces on the shelf from at or above that number to below it, the stock list gets one email:
   the item, what is left, and what usually goes out, so the next batch can be prepared. */
function shelfLeft(state) {
  const today = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  const addDays = (ds, n) => { const t = new Date(ds + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + (+n || 0)); return t.toISOString().slice(0, 10); };
  const left = {};
  (state.batches || []).forEach((b) => {
    if (b.voided || (b.madeOn && addDays(b.madeOn, b.shelf) < today)) return;
    const n = (+b.qty || 0) - (b.sales || []).reduce((a, s) => a + (+s.qty || 0), 0);
    left[b.itemId] = (left[b.itemId] || 0) + Math.max(0, n);
  });
  return left;
}
async function lowStockCheck(env, before, after, origin) {
  if (!mailReady(env)) return;
  const was = shelfLeft(before), now = shelfLeft(after), hit = [];
  (after.items || []).forEach((it) => {
    const low = +it.low;
    if (!(low > 0)) return;
    const a = was[it.id] || 0, b = now[it.id] || 0;
    if (a >= low && b < low) hit.push(it.name + ": " + b + " left (warn below " + low + ")");
  });
  if (!hit.length) return;
  const list = ((after.alerts || {}).stock || []).length ? after.alerts.stock : String(env.ALERT_TO || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  if (!list.length) return;
  const mail = alertEmail({ title: "📦 Running low: " + hit.length + " item" + (hit.length === 1 ? "" : "s"), lines: hit.concat(["Time to prepare the next batch."]), link: (origin || "") + "/" });
  await sendMail(env, { to: list[0], bcc: list.slice(1).join(","), fromName: "Stock alerts", ...mail });
}

/* ============ the API ============ */

async function api(request, env, path, later = () => {}) {
  await ready(env);
  const board = await repaired(env, await loadBoard(env));
  const me = await whoAmI(request, env, board.state);

  /* another shop reading this shop's prices: no login, just the long link */
  if (/^\/api\/feed\/[A-Za-z0-9]{24,}\/report$/.test(path) && request.method === "POST") {
    const given = path.slice("/api/feed/".length, -"/report".length);
    if (!board.state.feedToken || !sameString(given, board.state.feedToken)) return json({ ok: false, error: "not_found" }, 404);
    const body = await request.json().catch(() => ({}));
    const key = shopKey(body.url), sm = body.summary || {};
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(key)) return json({ ok: false, error: "bad_request" }, 400);
    const num = (x) => (Number.isFinite(+x) ? Math.round(+x * 100) / 100 : 0);
    const row = { at: new Date().toISOString(), onHand: num(sm.onHand), soldToday: num(sm.soldToday), soldMonth: num(sm.soldMonth), toClear: num(sm.toClear),
      delivered: num(sm.delivered), owed: num(sm.owed), deal: String(sm.deal || "").slice(0, 20), month: String(sm.month || "").slice(0, 7) };
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await loadBoard(env), next = JSON.parse(JSON.stringify(cur.state));
      next.reports = next.reports || {};
      if (!next.reports[key] && Object.keys(next.reports).length >= 30) return json({ ok: false, error: "too_many" }, 400);
      next.reports[key] = row;
      if ((await saveBoard(env, cur.version, next)) != null) return json({ ok: true });
    }
    return json({ ok: false, error: "busy" }, 409);
  }
  if (path.startsWith("/api/feed/") && request.method === "GET") {
    const given = path.slice("/api/feed/".length);
    if (!board.state.feedToken || given.length < 24 || !sameString(given, board.state.feedToken)) return json({ ok: false, error: "not_found" }, 404);
    return json(feedBody(board.state));
  }

  if (path === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const who = String(body.user || "").trim().toLowerCase();
    const pin = String(body.pin || "").trim();
    const found = (board.state.team || []).find(
      (u) => (u.user || "").toLowerCase() === who || (u.name || "").trim().toLowerCase() === who
    );
    /* 5 wrong tries on one username locks it for 15 minutes (a 4-digit PIN is guessable otherwise) */
    const failKey = "loginfail:" + who.slice(0, 60);
    const failRow = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(failKey).first();
    const fail = failRow ? JSON.parse(failRow.v) : { n: 0, until: 0 };
    if (fail.until > Date.now()) {
      return json({ ok: false, error: "Too many wrong tries. Wait 15 minutes and try again." }, 429);
    }
    /* hash either way, so a wrong username and a wrong PIN cost the same time */
    const given = await pinHash(pin);
    if (!found || !sameString(given, found.pin)) {
      const n = fail.n + 1;
      await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)")
        .bind(failKey, JSON.stringify(n >= 5 ? { n: 0, until: Date.now() + 15 * 60e3 } : { n, until: 0 })).run();
      return json({ ok: false, error: "That username and PIN don't match." }, 401);
    }
    if (failRow) await env.DB.prepare("DELETE FROM meta WHERE k = ?").bind(failKey).run();
    return json(
      { ok: true, me: { id: found.id, name: found.name, user: found.user, role: found.role } },
      200,
      { "set-cookie": await issueSession(env, found.id) }
    );
  }

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, {
      "set-cookie": "ds=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    });
  }

  /* Admin recovery: whoever can set the ADMIN_RECOVERY secret in Cloudflare
     (the account owner) can set a new admin PIN from /recover. With no secret
     set, this is switched off. 5 wrong keys lock it for an hour. */
  if (path === "/api/recover" && request.method === "POST") {
    const key = String(env.ADMIN_RECOVERY || "");
    if (key.length < 12) {
      return json({ ok: false, error: "Recovery is switched off. Add the ADMIN_RECOVERY secret in Cloudflare first (12+ characters)." }, 403);
    }
    const lock = await env.DB.prepare("SELECT v FROM meta WHERE k = 'recoverfail'").first();
    const fail = lock ? JSON.parse(lock.v) : { n: 0, until: 0 };
    if (fail.until > Date.now()) return json({ ok: false, error: "Too many wrong keys. Try again in an hour." }, 429);
    const body = await request.json().catch(() => ({}));
    const given = String(body.key || "");
    if (!sameString(await sha256Hex("recover:" + given), await sha256Hex("recover:" + key))) {
      const n = fail.n + 1;
      await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('recoverfail', ?)")
        .bind(JSON.stringify(n >= 5 ? { n: 0, until: Date.now() + 3600e3 } : { n, until: 0 })).run();
      return json({ ok: false, error: "That recovery key isn't right." }, 403);
    }
    const who = String(body.user || "").trim().toLowerCase();
    const newPin = String(body.pin || "").trim();
    if (!/^\d{4,8}$/.test(newPin)) return json({ ok: false, error: "New PIN must be 4–8 digits." }, 400);
    const next = JSON.parse(JSON.stringify(board.state));
    const u = (next.team || []).find((x) => x.role === "admin" && ((x.user || "").toLowerCase() === who || (x.name || "").trim().toLowerCase() === who));
    if (!u) return json({ ok: false, error: "No admin with that username." }, 404);
    u.pin = await pinHash(newPin);
    next.defaultPins = next.team.some((x) => x.pin === SEED.defaultPinHash);
    next.updatedAt = new Date().toISOString();
    const version = await saveBoard(env, board.version, next);
    if (version == null) return json({ ok: false, error: "Someone saved at the same moment. Try again." }, 409);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM meta WHERE k = 'recoverfail'"),
      env.DB.prepare("DELETE FROM meta WHERE k = ?").bind("loginfail:" + (u.user || "").toLowerCase())
    ]);
    return json({ ok: true, user: u.user });
  }

  if (!me) return json({ ok: false, error: "signed_out" }, 401);

  if (path === "/api/state" && request.method === "GET") {
    return json({
      ok: true, version: board.version, state: forViewer(board.state, me),
      me: { id: me.id, name: me.name, user: me.user, role: me.role }
    });
  }

  if (path === "/api/state" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (typeof body.version !== "number" || !body.state || typeof body.state !== "object") {
      return json({ ok: false, error: "bad_request" }, 400);
    }
    if (body.version !== board.version) {
      return json({
        ok: false, error: "conflict", version: board.version,
        state: forViewer(board.state, me)
      }, 409);
    }
    const merged = mergeSave(board.state, body.state, me);
    const version = await saveBoard(env, board.version, merged);
    if (version != null && mailReady(env) && env.ALERT_TO) later(saleAlert(env, board.state, merged, me, new URL(request.url).origin));
    if (version != null) later(lowStockCheck(env, board.state, merged, new URL(request.url).origin));
    if (version != null) later(reportUp(env, merged, new URL(request.url).origin));
    if (version == null) {
      const now = await loadBoard(env);
      return json({
        ok: false, error: "conflict", version: now.version, state: forViewer(now.state, me)
      }, 409);
    }
    return json({ ok: true, version, state: forViewer(merged, me) });
  }

  if (path === "/api/feed/reset" && request.method === "POST") {
    if (!permsOf(me).canSetup) return json({ ok: false, error: "forbidden" }, 403);
    const next = JSON.parse(JSON.stringify(board.state)); next.feedToken = newFeedToken(); next.updatedAt = new Date().toISOString();
    const version = await saveBoard(env, board.version, next);
    if (version == null) return json({ ok: false, error: "conflict" }, 409);
    return json({ ok: true, version, state: forViewer(next, me) });
  }
  if (path === "/api/feed/pull" && request.method === "POST") {
    if (!permsOf(me).canDeliver) return json({ ok: false, error: "forbidden" }, 403);
    const r = await pullFeed(env, new URL(request.url).origin);
    if (!r.ok) return json(r, 400);
    const now = await loadBoard(env);
    return json({ ...r, version: now.version, state: forViewer(now.state, me) });
  }

  if (path === "/api/pin" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const oldPin = String(body.oldPin || "").trim();
    const newPin = String(body.newPin || "").trim();
    if (!/^\d{4,8}$/.test(newPin)) {
      return json({ ok: false, error: "New PIN must be 4–8 digits." }, 400);
    }
    if (!sameString(await pinHash(oldPin), me.pin)) {
      return json({ ok: false, error: "Your current PIN is not right." }, 403);
    }
    const next = JSON.parse(JSON.stringify(board.state));
    const t = next.team.find((u) => u.id === me.id);
    t.pin = await pinHash(newPin);
    next.defaultPins = next.team.some((u) => u.pin === SEED.defaultPinHash);
    next.updatedAt = new Date().toISOString();
    const version = await saveBoard(env, board.version, next);
    if (version == null) return json({ ok: false, error: "conflict" }, 409);
    return json({ ok: true, version });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

/* Owner alert: every new sale logged in Dee's Stock (all of it is desserts), one email per save. */
async function saleAlert(env, before, after, me, origin) {
  const seen = new Set();
  (before.batches || []).forEach((b) => (b.sales || []).forEach((s) => seen.add(b.id + "|" + s.at + "|" + s.qty)));
  const items = new Map((after.items || []).map((i) => [i.id, i.name]));
  const team = new Map((after.team || []).map((u) => [u.id, u.name]));
  const fresh = [];
  (after.batches || []).forEach((b) => (b.sales || []).forEach((s) => {
    if (s.kind || !(+s.qty > 0) || seen.has(b.id + "|" + s.at + "|" + s.qty)) return;   /* sales only, not gifts, waste or fixes */
    fresh.push({ name: items.get(b.itemId) || "Dessert", qty: +s.qty, ch: s.ch || "", by: team.get(s.by) || me.name, at: s.at });
  }));
  if (!fresh.length) return;
  const lines = fresh.map((f) => f.qty + "× " + f.name + (f.ch ? " · " + f.ch : "") + " · " + dubaiTime(f.at) + " · logged by " + f.by);
  const n = fresh.reduce((a, f) => a + f.qty, 0);
  const mail = alertEmail({ title: "🍰 " + n + " dessert" + (n === 1 ? "" : "s") + " sold", lines, link: origin + "/" });
  const set = ((after.alerts || {}).sales || []), list = set.length ? set : String(env.ALERT_TO || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  if (list.length) await sendMail(env, { to: list[0], bcc: list.slice(1).join(","), fromName: "Dee's Stock alerts", ...mail });
}

/* ============ the Worker ============ */

function harden(res) {
  const h = new Headers(res.headers);
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "same-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  h.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  /* nightly backup (cron in wrangler.jsonc); Cloudflare D1 Time Travel is the second safety net */
  async scheduled(event, env, ctx) {
    await ready(env);
    ctx.waitUntil(pullFeed(env).then((r) => console.log("price feed", JSON.stringify(r))).catch((e) => console.error("price feed failed", e && e.message)));
    ctx.waitUntil(nightlyBackup(env, { loadBoard }).then((n) => console.log("backup saved", n, "bytes"))
      .catch((e) => console.error("backup failed", e && e.message)));
  },
  async fetch(request, env, ctx) {
    /* emails go out in the background, after the reply; a failed email never fails the request */
    const later = (p) => { const q = Promise.resolve(p).catch((e) => console.error("background task failed", e && e.message)); if (ctx && ctx.waitUntil) ctx.waitUntil(q); };
    const url = new URL(request.url);

    /* after a move: the old address sends every visit (and every saved link, QR poster and shop link) to the new one */
    if (env.MOVED_TO && /^https:\/\/[a-z0-9.-]+$/i.test(env.MOVED_TO) && !url.pathname.startsWith("/__")) {
      /* phones that saved the card offline: the old service worker lets go and opens the new address */
      if (url.pathname === "/sw.js") return new Response(
        "self.addEventListener('install', function (e) { self.skipWaiting(); });\n" +
        "self.addEventListener('activate', function (e) { e.waitUntil(self.registration.unregister().then(function () { return self.clients.matchAll({ type: 'window' }); })" +
        ".then(function (cs) { cs.forEach(function (c) { var u = new URL(c.url); c.navigate(" + JSON.stringify(env.MOVED_TO) + " + u.pathname + u.search).catch(function () {}); }); })); });\n",
        { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      return Response.redirect(env.MOVED_TO + url.pathname + url.search, 308);
    }

    /* the Pass Card: its own API, its own page, and the truck poster's counter */
    if (url.pathname.startsWith("/api/pass/") || url.pathname === "/t" || url.pathname === "/scan") {
      try {
        await ready(env);
        return harden(await handlePass(request, env, url.pathname, {
          json, hmac, sameString, cookies, sessionSecret, loadBoard, saveBoard, whoAmI, later,
          repairNames: Object.keys(REPAIRS),
          lowCheck: (before, after) => Promise.all([lowStockCheck(env, before, after, url.origin), reportUp(env, after, url.origin)])
        }));
      } catch (err) {
        return harden(json({ ok: false, error: "server_error", detail: String(err && err.message) }, 500));
      }
    }
    if (url.pathname === "/recover") {
      return harden(await env.ASSETS.fetch(new Request(new URL("/recover.html", url), request)));
    }
    /* the card used to live at /pass: saved links and home-screen icons still open */
    if (url.pathname === "/pass" || url.pathname.startsWith("/pass/")) {
      return Response.redirect(new URL("/tap" + url.pathname.slice(5) + url.search, url).toString(), 301);
    }
    if (url.pathname === "/tap" || url.pathname.startsWith("/tap/")) {
      return harden(await env.ASSETS.fetch(new Request(new URL("/tap", url), request)));
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return harden(await api(request, env, url.pathname, later));
      } catch (err) {
        return harden(json({ ok: false, error: "server_error", detail: String(err && err.message) }, 500));
      }
    }
    if (url.pathname === "/robots.txt") {
      return harden(new Response("User-agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      }));
    }
    /* everything else is the app itself */
    const asset = await env.ASSETS.fetch(new Request(new URL("/", url), request));
    return harden(asset);
  }
};
