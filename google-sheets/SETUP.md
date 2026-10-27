# Google Sheets via Apps Script

This project syncs a tenant's domain snapshot to Google Sheets through an Apps Script web app. A Google service-account key is not required.

1. Open the spreadsheet and open Extensions > Apps Script.
2. Paste the project's Code.gs file into Apps Script.
3. In Apps Script Project Settings > Script Properties, add SPREADSHEET_ID (the ID between /d/ and /edit in the Sheets URL) and SYNC_SECRET (a long random secret).
4. Run setupSheet() once and approve the permissions. This creates Domains and Reminder Logs tabs.
5. Deploy > New deployment > Web app. Execute as Me; permit unauthenticated requests if the deployment options allow it. Copy the URL ending in /exec.
6. In Cloudflare Worker Variables and Secrets, set SHEETS_WEB_APP_URL to that /exec URL and SHEETS_SYNC_SECRET to the same secret as SYNC_SECRET. Do not commit or share the secret.
7. Send /admin_sheet from an admin Telegram account to test. Add/import/edit/renew/delete sync automatically.

If the script changes, edit the deployment and publish a new version. The bridge replaces rows for the current tenant while preserving other tenants' rows. It syncs domain records, not reminder delivery logs. Check Cloudflare Worker logs and Apps Script execution logs when sync fails.
