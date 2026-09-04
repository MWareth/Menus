# Dee's Stock — the hosted version

The same board the team already uses, moved off the Claude link and onto your
own hosting. Nobody needs a Claude account any more: they open a web address,
type their username and PIN, and log a sale.

Two things this version can do that the old one could not:

- **the PIN is checked on the server**, so the hashes never reach the browser;
- **the truck never receives the recipes at all** — it gets the cost totals it
  needs to settle against, and nothing else. On the old board the ingredients
  were hidden by the screen; here they are hidden by the server.

---

## Putting it live — about ten minutes, once

You need a free Cloudflare account and Node installed on your computer.

**1. Get the code onto your machine**

```bash
git clone https://github.com/MWareth/menus.git
cd menus/dees-stock-site
npm install
```

**2. Sign in to Cloudflare**

```bash
npx wrangler login
```

That opens a browser window. Approve it and come back.

**3. Make the database**

```bash
npx wrangler d1 create dees-stock
```

It prints a block ending in something like:

```
database_id = "8f3c1a90-....-............"
```

Copy that id, open `wrangler.jsonc`, and paste it over
`PASTE_YOUR_DATABASE_ID_HERE`.

**4. Put it live**

```bash
npx wrangler deploy
```

It prints your address — something like `https://dees-stock.<your-name>.workers.dev`.
That is the link you send the team. Open it, sign in with your usual username
and PIN, and today's board is already there.

---

## Afterwards

- **Changing anything later:** run `npx wrangler deploy` again from the same
  folder after pulling the latest code (`git pull`).
- **Your own domain:** add it in the Cloudflare dashboard under the Worker's
  *Settings → Domains & Routes*. One record, no rebuild.
- **The data:** lives in the D1 database on your account. `npx wrangler d1
  execute dees-stock --remote --command "SELECT json FROM board"` prints the
  whole board if you ever want it out.
- **Backups:** the board is one row of JSON. The command above, piped to a
  file, is a complete backup.

## What is in here

| | |
|---|---|
| `src/worker.js` | the server: login, the board API, the permission rules |
| `src/seed.js` | the board as it stood when this was built — written once, on the first visit |
| `public/index.html` | the app itself, built from `../dees-stock-app/index.html` |
| `build-client.mjs` | rebuilds `public/index.html` from that source |
| `wrangler.jsonc` | the Cloudflare settings, including the database id you paste in |

The screens are generated from the original board app rather than copied, so
the two cannot drift apart. After changing `../dees-stock-app/index.html`, run
`node build-client.mjs` and deploy.

## How saving works

The whole board is one JSON document in the database, with a version number.
Every save sends the version it was built on; if somebody else saved in the
meantime the write is refused and that person's board comes back instead, so
two phones cannot quietly overwrite each other.

What each side is allowed to change is decided on the server, not in the page:

- **the truck** may only add movements to a lot — sold, given away, binned.
  Anything else in what it sends is ignored, and the stored board wins.
- **Dee's side** may change items, recipes, orders and payments.
- **only an admin** may change the team, and a PIN is only ever written when a
  fresh one was actually typed.
