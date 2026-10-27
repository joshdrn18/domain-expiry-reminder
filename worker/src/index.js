const REMINDER_DAYS = [30, 14, 7, 3, 1, 0];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Domain Expiry Reminder is running.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const secret = env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret || url.pathname !== `/webhook/${secret}` || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    let update;
    try { update = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
    if (update.message) {
      ctx.waitUntil(handleMessage(update.message, env));
    }
    return new Response("OK");
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runReminders(env));
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function esc(s) { return String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function validDomain(domain) {
  const d = String(domain || "").toLowerCase().replace(/\.$/, "");
  if (d.length < 3 || d.length > 253 || !d.includes(".")) return false;
  return d.split(".").every(label => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function normalizeDomain(d) { return String(d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, ""); }
function tenantIdForChat(chatId) { return `tg_${String(chatId).replace(/-/g, "n")}`; }
function actorId(message) { return String(message.from?.id ?? "unknown"); }
function isAdmin(message, env) {
  const adminIds = String(
    env.ADMIN_TELEGRAM_ID || env.ADMIN_TELEGRAM_IDS || ""
  )
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

  return adminIds.includes(String(message.from?.id || ""));
}
async function tg(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.description || `Telegram API ${res.status}`);
  return data.result;
}
async function send(env, chatId, text) {
  return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}
async function ensureChat(message, env) {
  const chatId = String(message.chat.id);
  const tenantId = tenantIdForChat(chatId);
  const chatType = message.chat.type || "private";
  const title = message.chat.title || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ") || "Private chat";
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id) VALUES (?)").bind(tenantId).run();
  await env.DB.prepare(`INSERT INTO chats (chat_id, tenant_id, chat_type, title)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, chat_type=excluded.chat_type`)
    .bind(chatId, tenantId, chatType, title).run();
  return { chatId, tenantId, chatType, title };
}
async function logAction(env, tenantId, chatId, actor, action, details = "") {
  await env.DB.prepare("INSERT INTO audit_logs (tenant_id, chat_id, actor_id, action, details) VALUES (?, ?, ?, ?, ?)")
    .bind(tenantId, chatId, actor, action, String(details).slice(0, 1000)).run();
}
function helpText() {
  return `<b>Domain Expiry Reminder</b>

<b>Tambah satu domain</b>
<code>/add example.com 2027-03-15 Cloudflare</code>

<b>Import banyak domain (maks. 25 baris)</b>
<code>/import
example.com | 2027-03-15 | Cloudflare
myshop.net | 2027-04-20 | Namecheap</code>

<b>Perintah lain</b>
/list — daftar domain
/check — domain yang kedaluwarsa dalam 30 hari
/detail domain.com — detail domain
/edit domain.com YYYY-MM-DD — ubah tanggal
/renew domain.com YYYY-MM-DD — catat tanggal kedaluwarsa baru
/delete domain.com — hapus domain
/rdap domain.com — cek data RDAP (informasi saja)
/help — bantuan

Reminder otomatis: H-30, H-14, H-7, H-3, H-1 dan H-0.
Gunakan bot di grup tempat reminder ingin dikirim.`;
}
async function handleMessage(message, env) {
  if (!message.text || !message.chat?.id) return;
  const chat = await ensureChat(message, env);
  const text = message.text.trim();
  const cmdMatch = text.match(/^\/([a-z_]+)(?:@\w+)?\b/i);
  if (!cmdMatch) return;
  const cmd = cmdMatch[1].toLowerCase();
  const args = text.slice(cmdMatch[0].length).trim();
  const chatId = chat.chatId, tenantId = chat.tenantId, actor = actorId(message);

  try {
    if (cmd === "start" || cmd === "help") return await send(env, chatId, helpText());

    if (cmd === "import") {
      const body = args;
      const rows = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!rows.length) return await send(env, chatId,
        `Format import (maks. 25 domain):\n<code>/import\nexample.com | 2027-03-15 | Cloudflare\nmyshop.net | 2027-04-20 | Namecheap</code>`);
      if (rows.length > 25) return await send(env, chatId, `Import ditolak: ada ${rows.length} baris. Maksimal 25 domain per pesan.`);
      const current = await env.DB.prepare("SELECT COUNT(*) AS n FROM domains WHERE tenant_id=?").bind(tenantId).first();
      const limit = Math.max(1, Number(env.MAX_DOMAINS_PER_TENANT || 500));
      let remaining = Math.max(0, limit - Number(current?.n || 0));
      let added = 0, duplicates = [], invalid = [], overLimit = [];
      for (let i = 0; i < rows.length; i++) {
        const parts = rows[i].split("|").map(x => x.trim());
        if (parts.length < 3) { invalid.push(`${i + 1}. format harus domain | YYYY-MM-DD | registrar`); continue; }
        const domain = normalizeDomain(parts[0]), expiry = parts[1], registrar = parts.slice(2).join(" | ").trim() || "Unknown";
        if (!validDomain(domain) || !validDate(expiry)) { invalid.push(`${i + 1}. ${parts[0]} — domain/tanggal tidak valid`); continue; }
        if (remaining <= 0) { overLimit.push(domain); continue; }
        try {
          await env.DB.prepare(`INSERT INTO domains (tenant_id, chat_id, domain, expiry_date, registrar, created_by)
            VALUES (?, ?, ?, ?, ?, ?)`).bind(tenantId, chatId, domain, expiry, registrar, actor).run();
          added++; remaining--;
          await logAction(env, tenantId, chatId, actor, "domain_import", `${domain}|${expiry}|${registrar}`);
        } catch (e) {
          if (/unique|constraint/i.test(String(e))) duplicates.push(domain);
          else throw e;
        }
      }
      if (added) await syncTenant(env, tenantId, chatId);
      const lines = [`<b>Import selesai</b>`, `Berhasil ditambahkan: ${added}/${rows.length}`];
      if (duplicates.length) lines.push(`\n<b>Domain duplikat (tidak ditimpa):</b>\n${duplicates.map(esc).join("\n")}`);
      if (invalid.length) lines.push(`\n<b>Baris tidak valid:</b>\n${invalid.map(esc).join("\n")}`);
      if (overLimit.length) lines.push(`\n<b>Melebihi batas akun:</b>\n${overLimit.map(esc).join("\n")}`);
      return await send(env, chatId, lines.join("\n"));
    }

    if (cmd === "add") {
      const p = args.split(/\s+/);
      const domain = normalizeDomain(p[0]), expiry = p[1], registrar = p.slice(2).join(" ") || "Unknown";
      if (!validDomain(domain) || !validDate(expiry)) return await send(env, chatId, "Format: <code>/add domain.com YYYY-MM-DD Registrar</code>");
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM domains WHERE tenant_id=?").bind(tenantId).first();
      if (Number(count?.n || 0) >= Number(env.MAX_DOMAINS_PER_TENANT || 500)) return await send(env, chatId, "Batas domain tenant sudah tercapai.");
      try {
        await env.DB.prepare("INSERT INTO domains (tenant_id, chat_id, domain, expiry_date, registrar, created_by) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(tenantId, chatId, domain, expiry, registrar, actor).run();
      } catch (e) {
        if (/unique|constraint/i.test(String(e))) return await send(env, chatId, `Domain <b>${esc(domain)}</b> sudah ada. Pakai /edit atau /renew.`);
        throw e;
      }
      await logAction(env, tenantId, chatId, actor, "domain_add", `${domain}|${expiry}|${registrar}`);
      await syncTenant(env, tenantId, chatId);
      return await send(env, chatId, `Domain ditambahkan: <b>${esc(domain)}</b>\nExpiry: ${expiry}\nRegistrar: ${esc(registrar)}`);
    }

    if (cmd === "list" || cmd === "check") {
      const result = await env.DB.prepare("SELECT domain, expiry_date, registrar FROM domains WHERE tenant_id=? ORDER BY expiry_date ASC, domain ASC").bind(tenantId).all();
      let domains = result.results || [];
      if (cmd === "check") domains = domains.filter(d => daysUntil(d.expiry_date, env.APP_TIMEZONE || "Asia/Kuala_Lumpur") <= 30);
      if (!domains.length) return await send(env, chatId, cmd === "check" ? "Tidak ada domain yang kedaluwarsa dalam 30 hari." : "Belum ada domain. Tambahkan dengan /add atau /import.");
      const shown = domains.slice(0, 80).map(d => {
        const days = daysUntil(d.expiry_date, env.APP_TIMEZONE || "Asia/Kuala_Lumpur");
        const status = days < 0 ? `lewat ${Math.abs(days)} hari` : days === 0 ? "hari ini" : `${days} hari lagi`;
        return `• <b>${esc(d.domain)}</b> — ${d.expiry_date} (${status}) · ${esc(d.registrar)}`;
      });
      return await send(env, chatId, `<b>${cmd === "check" ? "Perlu diperhatikan" : "Daftar domain"} (${domains.length})</b>\n${shown.join("\n")}${domains.length > 80 ? "\n…dan lainnya" : ""}`);
    }

    if (cmd === "detail") {
      const domain = normalizeDomain(args.split(/\s+/)[0]);
      const d = await env.DB.prepare("SELECT domain, expiry_date, registrar, created_at, updated_at FROM domains WHERE tenant_id=? AND domain=?").bind(tenantId, domain).first();
      if (!d) return await send(env, chatId, `Domain ${esc(domain)} tidak ditemukan.`);
      const days = daysUntil(d.expiry_date, env.APP_TIMEZONE || "Asia/Kuala_Lumpur");
      return await send(env, chatId, `<b>${esc(d.domain)}</b>\nExpiry: ${d.expiry_date}\nSisa: ${days < 0 ? `lewat ${-days} hari` : `${days} hari`}\nRegistrar: ${esc(d.registrar)}\nDibuat: ${d.created_at}\nDiubah: ${d.updated_at}`);
    }

    if (cmd === "edit" || cmd === "renew") {
      const p = args.split(/\s+/), domain = normalizeDomain(p[0]), expiry = p[1], registrar = p.slice(2).join(" ");
      if (!validDomain(domain) || !validDate(expiry)) return await send(env, chatId, `Format: <code>/${cmd} domain.com YYYY-MM-DD</code>`);
      const existing = await env.DB.prepare("SELECT id, registrar FROM domains WHERE tenant_id=? AND domain=?").bind(tenantId, domain).first();
      if (!existing) return await send(env, chatId, `Domain ${esc(domain)} tidak ditemukan.`);
      await env.DB.prepare("UPDATE domains SET expiry_date=?, registrar=?, updated_at=datetime('now') WHERE id=?")
        .bind(expiry, registrar || existing.registrar, existing.id).run();
      await logAction(env, tenantId, chatId, actor, cmd, `${domain}|${expiry}`);
      await syncTenant(env, tenantId, chatId);
      return await send(env, chatId, `Data <b>${esc(domain)}</b> diperbarui.\nExpiry baru: ${expiry}`);
    }

    if (cmd === "delete") {
      const domain = normalizeDomain(args.split(/\s+/)[0]);
      if (!validDomain(domain)) return await send(env, chatId, "Format: <code>/delete domain.com</code>");
      const result = await env.DB.prepare("DELETE FROM domains WHERE tenant_id=? AND domain=?").bind(tenantId, domain).run();
      if (!result.meta?.changes) return await send(env, chatId, `Domain ${esc(domain)} tidak ditemukan.`);
      await logAction(env, tenantId, chatId, actor, "domain_delete", domain);
      await syncTenant(env, tenantId, chatId);
      return await send(env, chatId, `Domain <b>${esc(domain)}</b> dihapus.`);
    }

    if (cmd === "rdap") {
      const domain = normalizeDomain(args.split(/\s+/)[0]);
      if (!validDomain(domain)) return await send(env, chatId, "Format: <code>/rdap domain.com</code>");
      const info = await rdapLookup(domain);
      return await send(env, chatId, info
        ? `<b>RDAP: ${esc(domain)}</b>\n${esc(info)}\n\nInfo RDAP hanya referensi. Tanggal reminder tidak diubah otomatis.`
        : `Data RDAP tidak ditemukan untuk ${esc(domain)} atau TLD belum mendukung RDAP.`);
    }

    if (cmd === "admin_sheet" || cmd === "sheetmap") {
      if (!isAdmin(message, env)) return await send(env, chatId, "Perintah ini khusus admin.");
      return await send(env, chatId, "Mapping spreadsheet pelanggan diatur lewat Worker secret <code>TENANT_SHEET_MAP_JSON</code>. Setelah mengubah secret, redeploy Worker jika diperlukan.");
    }

    return await send(env, chatId, "Perintah tidak dikenal. Ketik /help.");
  } catch (e) {
    console.error("Bot command error", e?.stack || e);
    return await send(env, chatId, "Terjadi error saat memproses perintah. Cek Worker Logs.");
  }
}

function dateInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function daysUntil(isoDate, timezone) {
  const today = dateInTimezone(new Date(), timezone);
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}
async function runReminders(env) {
  const tzDefault = env.APP_TIMEZONE || "Asia/Kuala_Lumpur";
  const chats = await env.DB.prepare("SELECT chat_id, tenant_id, timezone FROM chats").all();
  for (const chat of (chats.results || [])) {
    const domains = await env.DB.prepare("SELECT id, domain, expiry_date, registrar FROM domains WHERE tenant_id=?").bind(chat.tenant_id).all();
    for (const d of (domains.results || [])) {
      const days = daysUntil(d.expiry_date, chat.timezone || tzDefault);
      if (!REMINDER_DAYS.includes(days)) continue;
      const already = await env.DB.prepare("SELECT id FROM reminder_logs WHERE domain_id=? AND chat_id=? AND expiry_date=? AND reminder_day=?")
        .bind(d.id, chat.chat_id, d.expiry_date, days).first();
      if (already) continue;
      const phrase = days === 0 ? "KEDALUWARSA HARI INI" : `kedaluwarsa dalam ${days} hari`;
      try {
        await send(env, chat.chat_id, `⏰ <b>Domain expiry reminder</b>\n<b>${esc(d.domain)}</b> akan ${phrase}.\nTanggal: ${d.expiry_date}\nRegistrar: ${esc(d.registrar)}\n\nJika sudah diperpanjang, gunakan <code>/renew ${esc(d.domain)} YYYY-MM-DD</code>.`);
        await env.DB.prepare("INSERT OR IGNORE INTO reminder_logs (domain_id, chat_id, expiry_date, reminder_day) VALUES (?, ?, ?, ?)")
          .bind(d.id, chat.chat_id, d.expiry_date, days).run();
      } catch (e) {
        console.error("Reminder send failed", chat.chat_id, d.domain, String(e));
      }
    }
  }
}

async function syncTenant(env, tenantId, chatId) {
  try {
    const data = await env.DB.prepare("SELECT domain, expiry_date, registrar, created_at, updated_at FROM domains WHERE tenant_id=? ORDER BY expiry_date, domain")
      .bind(tenantId).all();
    const rows = [["Tenant ID", "Chat ID", "Domain", "Expiry Date", "Registrar", "Created At", "Updated At"]];
    for (const d of (data.results || [])) rows.push([tenantId, chatId, d.domain, d.expiry_date, d.registrar, d.created_at, d.updated_at]);
    const masterId = env.MASTER_SHEET_ID;
    if (masterId) await writeSheet(env, masterId, env.MASTER_SHEET_TAB || "Domains", rows, tenantId);
    const mapping = parseJson(env.TENANT_SHEET_MAP_JSON || "{}");
    const customerSheetId = mapping[tenantId];
    if (customerSheetId) await writeSheet(env, customerSheetId, "Domains", rows, tenantId);
    await env.DB.prepare("INSERT INTO sheet_sync_logs (tenant_id, chat_id, target, status, details) VALUES (?, ?, ?, ?, ?)")
      .bind(tenantId, chatId, "google_sheets", "success", `rows=${rows.length - 1}`).run();
  } catch (e) {
    console.error("Sheet sync failed", String(e));
    await env.DB.prepare("INSERT INTO sheet_sync_logs (tenant_id, chat_id, target, status, details) VALUES (?, ?, ?, ?, ?)")
      .bind(tenantId, chatId, "google_sheets", "error", String(e).slice(0, 1000)).run().catch(() => {});
  }
}
function parseJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function utf8Base64url(s) { return base64url(new TextEncoder().encode(s)); }
async function signRS256(privateKeyPem, data) {
  const pem = privateKeyPem.replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const keyBytes = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return base64url(new Uint8Array(signature));
}
async function googleAccessToken(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) throw new Error("Google service account credentials missing");
  const now = Math.floor(Date.now() / 1000);
  const header = utf8Base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = utf8Base64url(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = await signRS256(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, unsigned);
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error(`Google OAuth failed: ${JSON.stringify(result).slice(0, 400)}`);
  return result.access_token;
}
async function writeSheet(env, spreadsheetId, tab, rows, tenantId) {
  const token = await googleAccessToken(env);
  const safeTab = String(tab).replace(/'/g, "''");
  const range = `'${safeTab}'!A:G`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ range, majorDimension: "ROWS", values: rows })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Sheets API error ${response.status}: ${JSON.stringify(result).slice(0, 400)}`);
  await env.DB.prepare("INSERT INTO sheet_sync_logs (tenant_id, target, status, details) VALUES (?, ?, ?, ?)")
    .bind(tenantId, spreadsheetId, "success", `updated ${rows.length - 1} rows`).run();
}
async function rdapLookup(domain) {
  try {
    const bootstrapRes = await fetch("https://data.iana.org/rdap/dns.json");
    if (!bootstrapRes.ok) return null;
    const bootstrap = await bootstrapRes.json();
    const tld = domain.split(".").pop().toLowerCase();
    let base = null;
    for (const item of bootstrap.services || []) {
      if (item[0]?.map(x => x.toLowerCase()).includes(tld)) { base = item[1]?.[0]; break; }
    }
    if (!base) return null;
    const response = await fetch(`${base.replace(/\/+$/, "")}/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: "application/rdap+json, application/json" }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const events = (data.events || []).filter(e => /expiration/i.test(e.eventAction || ""));
    const expiry = events[0]?.eventDate || null;
    const registrar = data.entities?.find(e => (e.roles || []).includes("registrar"))?.vcardArray?.[1]?.find(x => x[0] === "fn")?.[3];
    return `Tanggal expiry RDAP: ${expiry ? expiry.slice(0, 10) : "tidak disediakan"}\nRegistrar RDAP: ${registrar || "tidak disediakan"}`;
  } catch (e) {
    console.error("RDAP lookup error", String(e));
    return null;
  }
}
