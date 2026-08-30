# Dee'serts Stock — shared stock & sales board

Live app: https://claude.ai/code/artifact/f503334d-b1a3-494e-99ac-d8e61fe67eed

Single self-contained page. State lives in the `<script id="app-state">` JSON block; every
write republishes the whole page via the `artifact` capability, so all viewers share one record.

## How it works
- **Deliveries** (Dee's side) — qty, cost/unit, made-on date. Locks on save; price, cost and
  shelf life are *snapshotted* onto the batch so later Setup edits never rewrite history.
- **Sales** (truck side) — append-only entries against a batch. Cannot oversell.
- **Expiry** — per-item shelf life (default 2 days). Batch expires on `madeOn + shelf`.
  Status: IN DATE / EXPIRES TOMORROW / LAST DAY / EXPIRED. Unsold at expiry = waste.
- **Money** — revenue, cost, profit, waste, and the configurable split (% and profit-vs-revenue basis).
- **Setup** (admin) — items, prices, ingredient costs, shelf life, team, PINs, split, housekeeping.

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
- Seed PINs are all `1234` — change them in Setup before sharing.

## Editing
Edit `index.html`, republish to the same artifact URL. Note the page rewrites its own source on
every save, so `buildDoc()` must stay in sync with the authored file's structure
(`app-style` / `app-state` / `app-code` element ids), and the code must never contain a literal
closing script tag.
