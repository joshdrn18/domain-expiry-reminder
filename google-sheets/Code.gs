const CONFIG = {
  SPREADSHEET_ID_PROPERTY: "SPREADSHEET_ID",
  SECRET_PROPERTY: "SYNC_SECRET"
};

const DOMAIN_HEADERS = [
  "Domain ID",
  "Domain",
  "Expiry Date",
  "Registrar",
  "Status",
  "Last Synced",
  "Telegram Chat ID"
];

function setupSheet() {
  const id = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.SPREADSHEET_ID_PROPERTY);
  if (!id) throw new Error("Set Script Property SPREADSHEET_ID first.");

  const ss = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName("Instructions") || ss.insertSheet("Instructions");
  sheet.clear();
  sheet.getRange(1, 1, 5, 2).setValues([
    ["Domain Expiry Reminder", "Google Sheets per Telegram group"],
    ["How it works", "Each Telegram chat/group gets its own Domains tab."],
    ["Sync", "The bot syncs after adding, importing, editing, renewing, deleting, or /admin_sheet."],
    ["Privacy", "All tabs are inside this spreadsheet; anyone who can access this file may see every group's tabs."],
    ["Note", "Do not share this spreadsheet publicly if group data is private."]
  ]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 2).setFontWeight("bold");
  sheet.autoResizeColumns(1, 2);
  Logger.log("Setup ready: " + ss.getUrl());
}

function doGet() {
  return json_({ ok: true, service: "Domain Exp Bot Sheets Bridge" });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const secret = PropertiesService.getScriptProperties()
      .getProperty(CONFIG.SECRET_PROPERTY);

    if (!secret || body.secret !== secret) {
      return json_({ ok: false, error: "Unauthorized" });
    }

    if (body.action === "sync_domains") return syncDomains_(body);
    return json_({ ok: false, error: "Unknown action" });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function syncDomains_(body) {
  if (!body.tenant_id || !body.chat_id || !Array.isArray(body.domains)) {
    return json_({ ok: false, error: "tenant_id, chat_id, and domains are required" });
  }

  const id = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.SPREADSHEET_ID_PROPERTY);
  if (!id) throw new Error("Missing Script Property SPREADSHEET_ID.");

  const ss = SpreadsheetApp.openById(id);
  const tabName = tabNameFor_(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) sheet = ss.insertSheet(tabName);

    if (sheet.getMaxColumns() < DOMAIN_HEADERS.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), DOMAIN_HEADERS.length - sheet.getMaxColumns());
    }

    sheet.getRange(1, 1, 1, DOMAIN_HEADERS.length).setValues([DOMAIN_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, DOMAIN_HEADERS.length).setFontWeight("bold");

    const now = new Date();
    const rows = body.domains
      .filter(d => d && d.id && d.domain && d.expiry_date)
      .map(d => [
        safeCell_(d.id),
        safeCell_(d.domain),
        safeCell_(d.expiry_date),
        safeCell_(d.registrar || "Unknown"),
        safeCell_(d.status || "active"),
        now,
        safeCell_(body.chat_id)
      ]);

    const oldLastRow = sheet.getLastRow();
    if (oldLastRow > 1) {
      sheet.getRange(2, 1, oldLastRow - 1, DOMAIN_HEADERS.length).clearContent();
    }
    if (rows.length) {
      sheet.getRange(2, 1, rows.length, DOMAIN_HEADERS.length).setValues(rows);
      sheet.getRange(2, 6, rows.length, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    }

    sheet.autoResizeColumns(1, DOMAIN_HEADERS.length);
    return json_({
      ok: true,
      tab: tabName,
      chat_id: String(body.chat_id),
      total: rows.length
    });
  } finally {
    lock.releaseLock();
  }
}

function tabNameFor_(body) {
  const type = String(body.chat_type || "private").toLowerCase();
  const prefix = type === "private" ? "Private" : "Group";
  const chatId = String(body.chat_id).replace(/[^0-9-]/g, "");
  const title = String(body.chat_title || "Telegram Chat")
    .replace(/[\\\/:*?\[\]]/g, " ")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim() || "Telegram Chat";
  const maxTitleLength = Math.max(10, 85 - prefix.length - chatId.length);
  return (prefix + " - " + title.slice(0, maxTitleLength) + " [" + chatId + "]").slice(0, 99);
}

function safeCell_(value) {
  const text = String(value == null ? "" : value);
  return /^[=+@]/.test(text) ? "'" + text : text;
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
