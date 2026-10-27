# Google Sheets API setup (no Apps Script)

1. Open Google Cloud Console and create/select a project.
2. Enable **Google Sheets API**.
3. Create a service account and generate a JSON key.
4. Copy the service account email and private key into Worker secrets. Do not commit the JSON key to GitHub.
5. Create an internal master spreadsheet and a tab named `Domains`.
6. Share that spreadsheet with the service account email as Editor.
7. For each buyer, create a separate spreadsheet and share it with the same service account as Editor.
8. Set Worker secret `TENANT_SHEET_MAP_JSON` to a JSON object mapping D1 tenant IDs to spreadsheet IDs. Tenant IDs use `tg_` plus the Telegram chat ID with minus signs replaced by `n`.
9. Set `MASTER_SHEET_ID` to the internal master spreadsheet ID.

The Worker writes the current tenant's domain snapshot into columns A:G on the configured tab. This starter does not create spreadsheets automatically; create them and configure the mapping first.
