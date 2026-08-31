# Dee'serts Stock — shared stock & sales board

Live app: https://claude.ai/code/artifact/f503334d-b1a3-494e-99ac-d8e61fe67eed

Single self-contained page. State lives in the `<script id="app-state">` JSON block; every
write republishes the whole page via the `artifact` capability, so all viewers share one record.

## How it works
- **Recipes** (Dee's side) — cost is built per whole batch (tray/cake) from supermarket pack
  prices: `line = recipe qty / pack qty × pack price`. Yield (pieces per batch ÷ pieces per
  portion) gives portions; `unit cost = batch cost / portions + packaging`. Live recalculation
  as you type; saved only on demand.
- **Deliveries** (Dee's side) — one drop can carry several items (`+ ADD ANOTHER ITEM`); each
  line is logged in whole batches ("2 trays") and converted to portions. All lines share one
  timestamp and a `drop` id so they read as a single delivery. Locks on save; unit price, unit
  cost and shelf life are *snapshotted* onto the batch so later recipe edits never rewrite history.
- **Sales** (truck side) — append-only entries against a batch. Cannot oversell.
- **Expiry** — per-item shelf life (default 2 days). Batch expires on `madeOn + shelf`.
  Status: IN DATE / EXPIRES TOMORROW / LAST DAY / EXPIRED. Unsold at expiry = waste.
- **Portions are whole.** `portionsPer = floor(pieces / piecesPerPortion)`; any remainder is
  flagged as left over per batch and its cost is carried by the sellable portions.
- **Money** — revenue, cost, profit, waste, and the configurable split (% and profit-vs-revenue basis).
- **Setup** (admin) — item names, prices, shelf life, team, PINs, split, housekeeping.
  (Ingredients, yield and packaging live on the Recipes tab.)

## Team & logins
Sign-in is a typed **username + PIN** — the team list is never shown on the lock screen, so
both halves are needed. Username match is case-insensitive and the person's full name also
works. PINs are SHA-256 hashed with a `deeserts:` prefix. Five wrong tries locks that browser
for 30 seconds.

| Username | Person | Side | Role | PIN |
|---|---|---|---|---|
| `marwan` | Marwan | Dee's | admin | 4071 |
| `dina` | Dina | Dee's | dees | 2258 |
| `majid` | Marwan Majid | Truck | truck | 6390 |
| `tarek` | Tarek | Truck | truck | 5184 |
| `cashier` | Truck Cashier | Truck | truck | 7726 |

Usernames are editable per person in Setup (2–20 chars, lowercase letters/digits/`.`/`-`/`_`,
must be unique). The PINs above are starters — everyone changes their own on the **MY PIN**
tab (current PIN + new PIN twice). An admin can still reset a forgotten one in Setup.

## Tabs
`STOCK` (landing) · `DELIVERIES` · `SALES` · `MONEY` · `RECIPES` (Dee's side) ·
`SETUP` (admin) · `MY PIN`.

The flow is Deliveries → Stock → Sales: a logged delivery becomes stock, stock gets sold down.
STOCK opens with on-hand / sold-today / last-day / expired counters, then a by-item summary
(on hand, batch count, first to expire), then every batch sorted most-urgent first.

## Roles
| Role | Deliveries | Sales | Setup |
|---|---|---|---|
| `admin` | yes | yes | yes |

Everyone, whatever their role, can change their own PIN on the MY PIN tab.
| `dees` | yes | no | no |
| `truck` | no | yes | no |

## Recipe confidentiality
The truck role cannot open the Recipes tab: it is absent from the tab strip, the router falls
back to Today for a disallowed tab (a stale `sessionStorage` tab on a shared phone was a real
hole), and `viewRecipes` refuses anyone without `canDeliver`. The truck sees only totals — cost
per delivery and the Money tab.

**But the ingredient rows are still in the published page source.** The whole board is one HTML
document, so anyone who can open the link can read the recipe by viewing source. Hiding it in
the UI is not the same as protecting it. To make it genuinely private the recipe would have to
be encrypted with a key only Dee's side holds (storing just the derived unit cost in clear), or
moved out of the shared document entirely.

## Where the data lives
There is no database. The board **is** the page: state sits in the `<script id="app-state">`
JSON block, and every save calls `artifact.publish()` with a freshly rebuilt copy of the whole
document, minting a new immutable version on claude.ai under the saver's own identity. Every
open view live-reloads to it. That is why `buildDoc()` must stay in sync with the file's
structure, and why the page must never grow unbounded (see Housekeeping in Setup).

## Dialogs
`window.confirm` and `window.prompt` are blocked in the sandboxed artifact frame — they return
immediately, silently cancelling whatever they guard. This once made SAVE DELIVERY & LOCK do
nothing at all. All five guarded actions use the in-page `ask()` dialog instead; never
reintroduce a native modal.

## Known limits
- **Logins are accountability, not real security.** Usernames and hashed PINs live in the page
  source, so a determined reader can crack a 4-digit PIN offline. Real access control is the
  artifact's own share permissions — anyone without write access gets a read-only board.
- **No push notifications.** Expiry "reminders" are the on-screen alert board; the page must be
  opened to see them.
- **One writer at a time.** Concurrent saves conflict; the loser reloads to the winner's version.

## Costed recipes (all five loaded, reconciled to the source sheets)

| Item | 1 batch = | Unit cost | Sells | Profit | Margin |
|---|---|---|---|---|---|
| Lazy Cake | 1 tray = 6 portions (+2 spare) | 20.84 | 26 | 5.16 | 19.9% |
| San Sebastian | 1 cake = 8 slices | 7.10 | 26 | 18.90 | 72.7% |
| Crème Brûlée | 1 batch = 5 ramekins | 6.54 | 20 | 13.46 | 67.3% |
| Brownie Bag | 1 tray = 4 bags of 4 | 14.63 | 26 | 11.37 | 43.7% |
| Mini Pavlova | 1 batch = 7 minis | 21.94 | 60 | 38.06 | 63.4% |

Unit cost includes packaging (0.45 / 1.09 / 0.25 / 0.25 / 1.68).

## The 50/50 settlement
Dee's fronts every ingredient cost `C`; the truck takes all the cash `R`. For Dee's to end on
its share `d` of the profit, the truck hands over `C×(1−d) + R×d` — its share of what Dee's
spent, plus Dee's share of what the truck holds. At 50/50 that is simply half of each, and it
leaves both sides on exactly `profit/2` whether profit is positive or negative.

The Money tab opens with the outstanding figure, the four lines it is built from, a
**stock built — who paid for it** table (per person: deliveries, portions, cost borne, the
truck's share of it), and a payments log. `RECORD A PAYMENT` (Dee's side / admin) reduces the
balance; payments live in `state.payments`.

Baking paper is an ingredient line at AED 1.15 per batch on cheesecake, brownies, lazy cake and
pavlova — not the crème brûlée, which is baked in ramekins.

## Corrections
Nothing is edited or deleted — mistakes are reversed on the record:
- **FIX COUNT** on a batch asks what has *actually* sold and appends the difference as a
  correction entry (flagged `fix`); both entries stay in the log.
- **VOID** on a delivery marks it voided with a written reason and drops it out of stock, cost
  and the split. Blocked for non-admins once anything has sold from it. Admins can **RESTORE**.

## Costing reference
Lazy Cake is seeded from the real sheet: batch AED 123.51, 26 pcs @ 2 pcs/portion = 13 portions,
AED 9.50 ingredient + 0.25 packaging = 9.75/unit, sells 26 → 16.25 profit, 62.5% margin.
Portion is confirmed at **2 pcs** (not 4) — set on the item note, the recipe yield and the
brand deck's dee'serts slide. The standalone menu board (outside this repo) still says 4 pcs
and needs the same correction.

## Header
Dee's mark recoloured to brown (`dees-brown.png`, embedded in the CSS as a data URI) above a
centred "Stock" — the logo already carries the name. The header scrolls; the tab strip sticks
to the top. The artifact's `<title>` stays "Dee's Stock" so it stays identifiable in a browser
tab and the artifact gallery, where the logo is not visible.

## Editing
Edit `index.html`, republish to the same artifact URL. Note the page rewrites its own source on
every save, so `buildDoc()` must stay in sync with the authored file's structure
(`app-style` / `app-state` / `app-code` element ids), and the code must never contain a literal
closing script tag.
