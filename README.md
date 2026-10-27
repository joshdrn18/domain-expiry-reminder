# Domain Expiry Reminder — Cloudflare Worker + D1 + Google Sheets API

Starter project for a Telegram bot that tracks domain expiry dates entered manually. No Google Apps Script and no registrar API integrations.

## Features
- Telegram bot works in private chats and groups.
- Bulk import up to 25 domains per message.
- Per-chat / per-group isolation in D1.
- Commands: `/start`, `/help`, `/add`, `/import`, `/list`, `/check`, `/detail`, `/edit`, `/renew`, `/delete`, `/rdap`.
- Scheduled reminders at H-30, H-14, H-7, H-3, H-1 and H-0.
- D1 is the operational source of truth.
- Google Sheets API v4 sync directly from Worker; no Apps Script.
- One internal master spreadsheet, plus optional separate spreadsheet per customer.
- Optional RDAP lookup is informational only and never overwrites the manually entered expiry date.

## Bulk import format
Send in the Telegram chat/group where reminders should be delivered:

```
/import
example.com | 2027-03-15 | Cloudflare
myshop.net | 2027-04-20 | Namecheap
myblog.org | 2027-05-01 | GoDaddy
example.my | 2027-06-12 | Exabytes
```

Up to 25 non-empty rows per import. Existing domains are not overwritten; use `/edit` or `/renew`.

## 1. Create D1
Create a Cloudflare D1 database and apply `worker/schema.sql`:

```bash
npx wrangler d1 create domain-expiry-db
npx wrangler d1 execute domain-expiry-db --remote --file=worker/schema.sql
```

Put the resulting database ID in `worker/wrangler.toml`.

## 2. Configure Worker
Copy `worker/wrangler.toml.example` to `worker/wrangler.toml`, then fill in the D1 database ID and your preferred values.

Set secrets:
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TELEGRAM_IDS
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put MASTER_SHEET_ID
npx wrangler secret put MASTER_SHEET_TAB
```

`ADMIN_TELEGRAM_IDS` is a comma-separated list of Telegram numeric user IDs.
For `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, paste the private key as provided by Google; the Worker normalizes escaped `\n` characters.

## 3. Google Sheets direct API (no Apps Script)
1. Create a Google Cloud project.
2. Enable **Google Sheets API**.
3. Create a service account and a JSON key.
4. Add the service account email as an **Editor** on the internal master spreadsheet.
5. For each customer's spreadsheet, share it with the same service account as **Editor**.
6. Put the service account email/private key into Worker secrets.
7. Put the internal spreadsheet ID in `MASTER_SHEET_ID`.
8. Create a master tab named `Domains` (or change `MASTER_SHEET_TAB`).
9. Optionally set `TENANT_SHEET_MAP_JSON` as a secret containing a JSON object mapping tenant IDs to customer spreadsheet IDs, for example:
   `{"tg_123456789":"1Abc...","tg_n987654321":"1Xyz..."}`

The Worker writes a snapshot to the master spreadsheet and, when configured, the customer's own spreadsheet. The sheet must be shared with the service account. Customer sheet IDs are configured by the admin; this starter does not automatically create Google spreadsheets.

## 4. Deploy
```bash
cd worker
npm install
npx wrangler deploy
```

Then register Telegram webhook. Replace values:
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/webhook/<TELEGRAM_WEBHOOK_SECRET>"
```

The secret is in the URL path. Keep it private.

## 5. Bindings / variables
- `DB`: D1 database binding.
- `APP_TIMEZONE`: timezone used to calculate reminder dates (default `Asia/Kuala_Lumpur`).
- `MAX_DOMAINS_PER_TENANT`: optional safety limit (default 500).
- `MASTER_SHEET_TAB`: master tab name (default `Domains`).
- `TENANT_SHEET_MAP_JSON`: optional tenant ID -> spreadsheet ID mapping. Configure as a Worker secret if it contains customer IDs.

## Security notes
- Keep bot token, webhook secret, Google service account key, and spreadsheet IDs private.
- Admin-only commands require sender ID in `ADMIN_TELEGRAM_IDS`.
- Do not put the service account JSON key in GitHub.
- This is a starter template. Test with a private test group and a test spreadsheet before using with paying customers.
