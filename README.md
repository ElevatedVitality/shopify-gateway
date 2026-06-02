# Shopify × Secure1Gateway Bridge
### Deployment & Setup Guide

---

## What This Does

This Node.js app sits between Shopify and EUPaymentz (Secure1Gateway).
When a customer checks out on your Shopify store, Shopify calls this app,
which securely processes the card and handles 3DS authentication.

```
Customer Checkout → Shopify → This App → EUPaymentz Gateway
                                              ↓
                                    3DS Bank Page (if needed)
                                              ↓
                                    /callback → Mark Order Paid in Shopify
```

---

## Step 1 — Set Up Railway

1. Go to **railway.app** and sign up (free tier is fine to start)
2. Click **New Project → Deploy from GitHub repo**
3. Push this code to a GitHub repo first (see Step 2), then connect it
4. Railway will auto-detect Node.js and deploy

**Important:** Upgrade to Railway's Starter plan ($5/mo) to get a **static outbound IP**.
You MUST register this IP with EUPaymentz or all transactions will be rejected.
After upgrading, find your static IP under: Project Settings → Networking → Static IP.

---

## Step 2 — Push Code to GitHub

```bash
cd shopify-gateway
git init
git add .
git commit -m "Initial gateway bridge"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/shopify-gateway.git
git push -u origin main
```

---

## Step 3 — Set Environment Variables in Railway

In your Railway project → Variables tab, add each of these:

| Variable | Where to find it |
|---|---|
| `GATEWAY_ACCOUNT_ID` | EUPaymentz welcome email |
| `GATEWAY_PASSWORD` | EUPaymentz welcome email |
| `GATEWAY_PASSPHRASE` | EUPaymentz welcome email |
| `SHOPIFY_SHOP_DOMAIN` | your-store.myshopify.com |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Partner Dashboard (see Step 4) |
| `SHOPIFY_WEBHOOK_SECRET` | Shopify Partner Dashboard → App → Webhooks |
| `APP_URL` | Your Railway URL (e.g. https://shopify-gateway-production.up.railway.app) |

---

## Step 4 — Create a Shopify Payment App

1. Go to **partners.shopify.com**
2. Click **Apps → Create App → Create app manually**
3. Name it (e.g. "EUPaymentz Gateway")
4. Under **App setup**, enable **Payment App** (Offsite/Direct)
5. Set these URLs in the app config:
   - **Payment session URL:** `https://your-app.up.railway.app/payment`
   - **Refund session URL:** `https://your-app.up.railway.app/refund`
6. Copy the **API credentials** — this is your `SHOPIFY_ACCESS_TOKEN`
7. Install the app on your store from the Partner Dashboard

---

## Step 5 — Register Your IP with EUPaymentz

Email **support@secure1gateway.com** with:
- Your Railway static IP address
- Your store URL
- Request to whitelist for live processing

They'll also need to switch your account from test mode to live.

---

## Step 6 — Test with Gateway Test Cards

While still in test mode, use these card numbers:

| Card Number | Result |
|---|---|
| 4444333322221111 | Approved (Direct) |
| 4444333322221210 | Approved (3DS) |
| 4444333322222101 | Declined (Direct) |
| 4444333322231011 | Declined (3DS) |

Use any future expiry date, any 3-digit CVC.

---

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/payment` | Initiate a payment |
| POST | `/callback` | Gateway posts result after 3DS |
| GET | `/return` | Customer redirect after 3DS |
| POST | `/refund` | Process a refund (Shopify webhook) |
| GET | `/health` | Health check |

---

## Understanding the Response Flow

### Direct Approval (no 3DS)
```
POST /payment → Gateway returns 00000 → markShopifyOrderPaid() → Done
```

### 3DS Flow
```
POST /payment
  → Gateway returns PEND + UrlToRedirect
  → Your frontend redirects customer to bank 3DS page
  → Customer authenticates with their bank
  → Bank redirects customer to GET /return
  → Gateway also posts to POST /callback (more reliable)
  → /callback verifies SHA, calls markShopifyOrderPaid()
  → Done
```

### Declined
```
POST /payment → Gateway returns error code → Return 402 to Shopify
```

---

## Refunds

Refunds are triggered automatically when you issue a refund from the Shopify admin.
Shopify sends a webhook to `/refund`, which calls the gateway's processRefund API.

**Note:** Only 1 refund per transaction is allowed. Partial refunds are supported.

---

## Monitoring

Railway shows real-time logs. Watch for:
- `[Payment] Approved directly` — clean transaction
- `[Payment] 3DS required` — customer going through bank auth
- `[Callback] 3DS approved` — successful after 3DS
- `[Payment] Declined` — check the code and message for reason
- `T0005 0002` error — SHA is wrong, check your passphrase
- `T0005 0056` error — your IP isn't whitelisted yet

---

## Troubleshooting

**All transactions returning T0005 0056 (Merchant IP Refused)**
→ Your Railway IP isn't registered with EUPaymentz yet. Email them your static IP.

**SHA verification errors (T0005 0002)**
→ Double-check GATEWAY_PASSPHRASE exactly matches what EUPaymentz gave you.
→ Ensure amount is formatted correctly (e.g. "99.99" not "99,99")

**Shopify not marking orders as paid**
→ Verify SHOPIFY_ACCESS_TOKEN has the correct permissions
→ Check that APP_URL is set to your live Railway URL (not localhost)

**3DS redirect not working**
→ Ensure merchant_url_return and merchant_url_callback in payment.js point to your live APP_URL
