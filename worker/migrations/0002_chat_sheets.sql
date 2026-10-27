CREATE TABLE IF NOT EXISTS chat_sheets (
  chat_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_sheets_tenant ON chat_sheets(tenant_id);
