# 🍛 IndoResto — Restaurant Operating System

Full-stack PWA restaurant management platform for the Indonesian market.  
Built for tablet/mobile-first operation with offline support.

## Modules

| Module | File | Status |
|--------|------|--------|
| 1. Queue / Waitlist | `apps/queue/` (inline in main demo) | ✅ |
| 2. Menu & Tablet Ordering | `apps/menu/` (inline in main demo) | ✅ |
| 3. Kitchen Display System | `apps/kds/` (inline in main demo) | ✅ |
| 4. Server Tablet | `apps/server-tablet/index.html` | ✅ |
| 5. Payment (Midtrans) | `apps/payment/index.html` | ✅ |
| 6. CRM / Loyalty | Embedded in server-tablet | ✅ |
| 7. Admin Dashboard | `apps/admin/` | 🔜 |

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS PWA (drop-in anywhere, no build step needed)
- **Backend**: Cloudflare Workers (`backend/api.js`)
- **Database**: PostgreSQL / Supabase (`backend/schema.sql`)
- **Real-time**: WebSocket via Cloudflare Durable Objects
- **Payments**: Midtrans SNAP + QRIS Core API
- **Notifications**: WhatsApp Cloud API

## Project Structure

```
indoresto/
├── apps/
│   ├── server-tablet/    Module 4 — serve & payment tablet
│   │   └── index.html
│   └── payment/          Module 5 — full payment flow
│       └── index.html
├── backend/
│   ├── api.js            Cloudflare Workers API (all routes)
│   └── schema.sql        PostgreSQL schema + triggers
├── lib/
│   └── indoresto.js      Shared client JS (WS, API, offline, audio)
├── public/
│   ├── manifest.json     PWA manifest
│   └── sw.js             Service worker (offline + push notifications)
└── README.md
```

## Quick Start

### 1. Database (Supabase or self-hosted PostgreSQL)

```bash
# Create database
psql $DATABASE_URL -f backend/schema.sql
```

### 2. Backend (Cloudflare Workers)

```bash
npm install -g wrangler
wrangler login
```

Edit `wrangler.toml`:
```toml
name = "indoresto-api"
main = "backend/api.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "indoresto"
database_id = "YOUR_D1_ID"

[vars]
MIDTRANS_BASE_URL = "https://app.sandbox.midtrans.com"
BASE_URL = "https://indoresto.your-domain.com"

# Secrets (use wrangler secret put):
# MIDTRANS_SERVER_KEY
# MIDTRANS_CLIENT_KEY
# WA_TOKEN
# WA_PHONE_ID
# JWT_SECRET
```

```bash
wrangler deploy
```

### 3. Frontend (any static host)

The apps are plain HTML — serve from GitHub Pages, Cloudflare Pages, or Nginx:

```bash
# Cloudflare Pages
wrangler pages deploy . --project-name=indoresto

# Or just open locally:
open apps/server-tablet/index.html
open apps/payment/index.html
```

### 4. PWA Installation

On tablet/phone: open the app URL → tap "Add to Home Screen"  
Works offline once installed (service worker caches all static assets).

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `MIDTRANS_SERVER_KEY` | Midtrans server key (`SB-Mid-server-...` for sandbox) |
| `MIDTRANS_CLIENT_KEY` | Midtrans client key |
| `MIDTRANS_BASE_URL` | `https://app.sandbox.midtrans.com` (sandbox) or `https://app.midtrans.com` |
| `WA_TOKEN` | WhatsApp Cloud API access token |
| `WA_PHONE_ID` | WhatsApp phone number ID from Meta Business |
| `JWT_SECRET` | Secret for JWT auth tokens |

## Midtrans Setup

1. Register at [midtrans.com](https://midtrans.com)
2. Get Sandbox keys from Dashboard → Settings → Access Keys
3. Enable QRIS in Dashboard → Settings → Payment Methods
4. Set webhook URL: `https://your-api.workers.dev/api/payments/webhook`

## WhatsApp Cloud API Setup

1. Create Meta Business account
2. Add WhatsApp Business at [developers.facebook.com](https://developers.facebook.com)
3. Create message templates:
   - `queue_reminder` — notifies customer when their turn is near
   - `payment_receipt` — sends receipt after payment

## WebSocket Events

Real-time events broadcast to all connected tablets:

| Event | Trigger | Payload |
|-------|---------|---------|
| `NEW_ORDER` | Customer places order | `{ orderId, tableId }` |
| `ORDER_STATUS` | KDS updates status | `{ orderId, status }` |
| `ORDER_READY` | All items marked ready | `{ orderId }` |
| `PAYMENT_DONE` | Payment confirmed | `{ orderId }` |
| `QUEUE_UPDATE` | Customer added/seated | `{ queueLength }` |

## Offline Behavior

- All static assets cached by service worker on first load
- Failed order mutations queued in IndexedDB
- Background sync via `sync` event when reconnected
- WebSocket auto-reconnects with exponential backoff (1s → 30s max)

## Push Notifications

Server tablets receive push notifications when:
- Kitchen marks order as ready
- Queue turn is approaching (5 min warning)

## Contributing / Deployment to GitHub

```bash
cd indoresto
git init
git remote add origin git@github.com:thomaskeren90/indoresto.git
git add .
git commit -m "feat: IndoResto modules 1-5"
git push -u origin main
```
