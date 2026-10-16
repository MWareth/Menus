# The Pass Card — product brief and client playbook

Owner: Marwan Wareth (MW Exposure). Status 16 Oct 2026. Paste this into a new conversation to start selling the Pass Card to new clients.

## 1. What the Pass Card is

A loyalty system that lives on the customer's phone, with no app to download. The customer scans a QR, joins in 30 seconds (name, mobile, email, 4-digit PIN), and gets a digital card with their own QR code. Staff scan that QR on any phone and tap what was bought. The customer gets stamps, points, games and a thank-you email.

Live sample: Smash & Pass food truck, Dubai (https://dees-stock.deestreats2026.workers.dev/pass).

### Features that exist today
- Two stamp cards (currently "Savory" and "Dee'serts"), buy 9 get the 10th free, cards renew by themselves, a completed-cards counter and fan levels.
- Smash Points on every order and game, spent at the counter on free items (400 / 900 points).
- Welcome surprise on the first order (a near-expiry dessert or 10% off).
- Scratch card from the 2nd order. Mini games (Burger Stack, Catch the Dee'sert, Crack the Brûlée, Perfect Smash) unlocked for 30 minutes after each order, unlimited plays, 2 points per order. Monthly leaderboards and achievements. Top Smashers of the month wins a free meal.
- English and Arabic (RTL), one tap to switch.
- Thank-you email after every order (Gmail SMTP with an app password), owner gets a BCC and dessert-sale alerts. Unsubscribe link.
- Staff side: scan or type the mobile number, tap items, STAMP. One stamp per card per order. Works offline (stamps queue and send later). Practice mode for games. Lockout after 5 wrong PINs.
- Owner page: scans of the poster QR, sign-ups, repeat rate, visits, best sellers, ratings and comments, points given/spent, game plays, customer list (copy to Excel), nightly backup + download, test email button, admin recovery page.
- One Pass Card per phone (device cookie), QR drawn on the phone in brand colours, home-screen icon.
- Stock module (optional, "Dee's Stock"): recipes and true cost, per-tray pricing, deliveries, sales, giveaways, waste, settlement between the supplier and the truck, P&L, activity log, Pass Card stamps auto-log dessert sales.

### Tech
- Cloudflare Worker + D1 database, deployed from GitHub (MWareth/Menus, folder dees-stock-site). Push to main auto-deploys.
- Customer and staff pages: public/pass.html. API: src/pass.js. Email: src/mail.js. Stock app: dees-stock-app/index.html built into public/index.html by build-client.mjs.
- Secrets per client: SESSION_SECRET, ADMIN_RECOVERY, SMTP_USER, SMTP_PASS, ALERT_TO.
- Running cost per client: about AED 0–25 a month (Cloudflare free tier, Gmail free).

### Sales material that exists
- Pitch deck (12 slides, speaker notes): https://claude.ai/artifact/Y8BkpvEDMe2DtiNKbHLbn8
- Client intake sheet (one record per lead, 1-day demo stage): https://claude.ai/artifact/HDaL5XnBuoUoGLkEmPUAq7
- Walkthrough video, 1:16, vertical, with music (Pass-Card-Walkthrough.mp4).
- Truck team guide (slides + PDF), A4 posters, QR cards, sticker sheet generator (stickers/make_sheet.py).
- Competitor research: UAE players charge about AED 70–450 a month, usually no setup fee (Stampli AED 69/179/369, Perkfull 149/249/449, YourLoop from 149, Loopy Loyalty ~AED 90–350, Stamp Me ~180–730). None has games, leaderboards, offline stamping or a costing module.

### Our edge
Games and leaderboards, Arabic-first, works offline, done-for-you setup in the client's brand (posters, stickers, staff guide), optional stock/costing, and a human who shows up at the shop.

## 2. Who to sell to (beyond trucks and restaurants)

Any place with repeat visits. The card adapts: a "stamp" is a visit, a service or an item.

| Business | Card 1 / Card 2 | Reward idea |
|---|---|---|
| Cafés, coffee shops | Coffee / Sweets | 10th coffee free |
| Juice, smoothie, açaí bars | Drinks / Bowls | 10th drink free |
| Barbers, salons | Haircut / Beard or Colour | 6th cut free, birthday trim |
| Nail and brow bars | Manicure / Pedicure | 6th free |
| Car wash | Wash / Detailing | 6th wash free |
| Laundry | Bags / Dry-clean | 10th bag free |
| Gyms, yoga, padel | Classes / Drop-ins | 10th class free, streaks |
| Pet grooming / vets | Grooming / Supplies | 6th groom free |
| Kids play areas | Entries / Parties | 10th entry free |
| Pharmacies, mini-marts | Visits over AED X | Points to spend |
| Bakeries, home bakers | Boxes / Cakes | 10th box free |

Points, games, leaderboards and the welcome surprise work for all of them. Games matter most where people wait (cafés, barbers, car washes, play areas).

## 3. Rate card (AED)

| Package | Setup | Monthly | Includes |
|---|---|---|---|
| Loyalty | 0 (free with annual) or 500 | 199 | Stamp cards, points, welcome surprise, games, leaderboard, Arabic, emails, owner page, posters + QR, staff guide, support |
| Loyalty Plus | 500 | 299 | Loyalty + Apple/Google Wallet card, birthday and win-back messages, Google review prompt, bring-a-friend (once built) |
| Full | 1,500 | 449 | Loyalty Plus + stock, recipes, costing, settlement and P&L |

Offers: first month free after the demo; pay yearly and get 2 months free. Add-ons: extra branch AED 99/mo, poster/sticker design pack AED 350, WhatsApp messages at cost + 20%, monthly content/photo package (MW Exposure).

## 4. New-client checklist (A to Z)

### A. Before selling (one-time, build once)
- [ ] White-label the app: brand name, logo, colours, card names, menu items, rewards, tagline, Arabic strings, sender email, all from a settings file per client. Nothing hardcoded for Smash & Pass.
- [ ] One Cloudflare Worker + D1 database per client (separate data). A script that creates a new client from the intake sheet.
- [ ] Demo mode: a copy that switches itself off after 1 day with a "contact us to continue" screen. Fake customers, stamps and leaderboard pre-filled so it looks alive. Reset button.
- [ ] "Powered by MW Exposure" footer on every client site (customer page, staff page, emails), linking to an MW Exposure landing page with a 1-minute video and a "Book a demo" form.
- [ ] Trade licence that covers software/IT services. A one-page service agreement (fee, support hours, data ownership: the client owns their customer data, privacy, cancellation with 30 days' notice).
- [ ] Payment: bank transfer or a payment link; invoice template.

### B. Finding clients
- [ ] Pick one area at a time (e.g. JVC, Arjan, Motor City). List 20 businesses from Instagram and Google Maps: name, type, Instagram, phone, owner if known.
- [ ] Put each one in the client sheet as a Lead with their links.
- [ ] Walk the area once: photo of the shop, menu and QR spots, chat with the staff, ask for the owner's WhatsApp.

### C. First message (WhatsApp or Instagram DM)
"Hi [name], I'm Marwan from MW Exposure in [area]. We built a loyalty card for Smash & Pass that lives on the customer's phone, no app: buy 9, the 10th is free, with games while they wait. I made a 1-day demo in [Business] colours so you can see it with your own menu: [demo link]. Can I show you in 15 minutes this week? It's free to try for a month."
- [ ] Send the demo link + the 1:16 video. Follow up after 2 days, then after a week, then stop.

### D. Build their demo (same day they reply, before the meeting)
- [ ] Collect: logo, colours, menu with prices (from Instagram, website or delivery app), card names, rewards, welcome surprise, languages, branches, opening hours.
- [ ] Create the client in the system, load the menu, generate 2 posters + the QR card + 10 fake customers.
- [ ] Set the 1-day demo expiry. Test on your phone: join, stamp, game, owner page.

### E. The 30-minute meeting
1. 3 min: their problem (paper cards, no data, nobody downloads apps).
2. 5 min: the walkthrough video on your phone or their TV.
3. 10 min: hand them your phone: they scan their own demo, join, you stamp them, they play a game, you show the owner page.
4. 5 min: the deck's pricing and "why us" slides; rate card on paper.
5. 5 min: the offer: free setup this month, first month free, go live within a week. Agree a start date. Collect logo files and the menu.
Bring: printed rate card, printed poster sample in their colours, the service agreement.

### F. Onboarding (week 1)
- [ ] Sign the agreement, collect setup fee (if any).
- [ ] Create the live site (their own link, e.g. passcard.mwexposure.com/[client] or their domain), Gmail app password for their emails, ALERT_TO.
- [ ] Load the real menu, rewards and prices. Add the owner and staff logins.
- [ ] Print: 2 A4 posters, QR cards for the counter, table tents, staff "how to stamp" sign, crew login QR, stickers if they package food.
- [ ] 15-minute staff training on site with the team guide. Show the owner page to the owner.
- [ ] Launch post for their Instagram (story + post with the QR) and 3 caption ideas.

### G. Running the account (monthly)
- [ ] Day 7 and day 30 check-ins: sign-ups, repeat rate, stamps, points. Fix anything the staff struggle with.
- [ ] Monthly report (1 page, from the owner page): customers, repeat rate, best sellers, top fans, reviews.
- [ ] Monthly invoice. Ask for a referral and a Google review at month 2.
- [ ] Seasonal campaign idea each month (Ramadan, National Day, summer): double points day, limited item, leaderboard prize.

## 5. What to build next (in order)
1. White-label settings + per-client database + create-client script (needed before client #1).
2. Demo mode with 1-day expiry and fake data.
3. "Powered by MW Exposure" footer + landing page with booking form.
4. Apple/Google Wallet card (biggest feature gap vs competitors).
5. Birthday reward and 30-day win-back message (email first, WhatsApp later).
6. Google review prompt after a 5-star rating.
7. Bring-a-friend referral points.
8. Multi-branch support and a franchise owner view.
9. Monthly PDF report emailed to the owner automatically.

## 6. More ideas
- Neighbourhood Pass: one card that works across 5–10 shops in the same area (coffee + barber + car wash). Each shop pays less, customers love it, and MW Exposure owns the network and the data.
- Lead engine: the "Powered by MW Exposure" footer plus a QR on every poster that says "Want this for your shop?" Every client site advertises you.
- Content bundle: MW Exposure already does media; sell loyalty + monthly photos/reels as one package. Higher price, stickier client.
- Table tents and sticker packs as a paid design add-on; print margin is good.
- Affiliate: AED 200 credit to any client who refers another client that signs.
- POS resellers and delivery-app account managers as partners: they meet 50 restaurants a month.
- Events: markets, football nights, school fairs. A temporary Pass Card for an event, sponsored by a brand.
- Corporate: office canteens and staff cafés (fixed crowd, perfect for leaderboards).
- Data as a product: anonymised "what's selling in JVC" insights once you have 20+ clients.
- Gamified leaderboard prizes sponsored by suppliers (e.g. a coffee brand funds the monthly prize).
- Arabic-first marketing: most competitors are English-only; lead with Arabic in the pitch for local brands.

## 7. Prompt to start the new conversation
"Read this brief. We're selling the Pass Card loyalty system under MW Exposure. Start with step B for [area]: find 20 local businesses with Instagram links, add them as leads, draft the first message for each in their tone, and prepare a 1-day demo plan per lead. Then prepare the 30-minute meeting pack: deck, video, rate card. Every client website must have a 'Powered by MW Exposure' footer."
