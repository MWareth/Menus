# Dee'serts Stock — shared stock & sales board

Live app: https://claude.ai/code/artifact/f503334d-b1a3-494e-99ac-d8e61fe67eed

Single self-contained page. State lives in the `<script id="app-state">` JSON block; every
write republishes the whole page via the `artifact` capability, so all viewers share one record.

## How it works
- **Recipes** (Dee's side) — cost is built per whole batch (tray/cake) from supermarket pack
  prices: `line = recipe qty / pack qty × pack price`. Yield (pieces per batch ÷ pieces per
  portion) gives portions; `unit cost = batch cost / portions + packaging`. Live recalculation
  as you type; saved only on demand.
- **Deliveries** (Dee's side) — logged in whole batches ("2 trays"), converted to portions
  automatically. Locks on save; unit price, unit cost and shelf life are *snapshotted* onto the
  batch so later recipe edits never rewrite history.
- **Sales** (truck side) — append-only entries against a batch. Cannot oversell.
- **Expiry** — per-item shelf life (default 2 days). Batch expires on `madeOn + shelf`.
  Status: IN DATE / EXPIRES TOMORROW / LAST DAY / EXPIRED. Unsold at expiry = waste.
- **Money** — revenue, cost, profit, waste, and the configurable split (% and profit-vs-revenue basis).
- **Setup** (admin) — item names, prices, shelf life, team, PINs, split, housekeeping.
  (Ingredients, yield and packaging live on the Recipes tab.)

## Team & PINs
Lock screen groups people by side. PINs are SHA-256 hashed with a `deeserts:` prefix.

| Person | Side | Role | PIN |
|---|---|---|---|
| Marwan | Dee's | admin | 4071 |
| Dina | Dee's | dees | 2258 |
| Marwan Majid | Truck | truck | 6390 |
| Tarek | Truck | truck | 5184 |
| Truck Cashier | Truck | truck | 7726 |

## Roles
| Role | Deliveries | Sales | Setup |
|---|---|---|---|
| `admin` | yes | yes | yes |
| `dees` | yes | no | no |
| `truck` | no | yes | no |

## Known limits
- **PINs are a name tag, not security.** SHA-256 hashed, but 4-digit PINs in a public page are
  brute-forceable. Real access control is the artifact's own share permissions — anyone without
  write access gets a read-only board.
- **No push notifications.** Expiry "reminders" are the on-screen alert board; the page must be
  opened to see them.
- **One writer at a time.** Concurrent saves conflict; the loser reloads to the winner's version.

## Costing reference
Lazy Cake is seeded from the real sheet: batch AED 123.51, 26 pcs @ 2 pcs/portion = 13 portions,
AED 9.50 ingredient + 0.25 packaging = 9.75/unit, sells 26 → 16.25 profit, 62.5% margin.
Portion is confirmed at **2 pcs** (not 4) — set on the item note, the recipe yield and the
brand deck's dee'serts slide. The standalone menu board (outside this repo) still says 4 pcs
and needs the same correction.

## Editing
Edit `index.html`, republish to the same artifact URL. Note the page rewrites its own source on
every save, so `buildDoc()` must stay in sync with the authored file's structure
(`app-style` / `app-state` / `app-code` element ids), and the code must never contain a literal
closing script tag.
