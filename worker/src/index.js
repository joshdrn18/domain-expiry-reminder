
const REMINDER_DAYS = [30, 14, 7, 3, 1, 0];
const DEFAULT_TIMEZONE = "Asia/Kuala_Lumpur";
const MAX_IMPORT_ROWS = 25;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Public health endpoint for external monitoring; does not access D1 or secrets.
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({
        ok: true,
        service: "domain-expiry-reminder",
        status: "healthy",
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Domain Expiry Reminder is running.", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    const secret = env.TELEGRAM_WEBHOOK_SECRET;

    if (
      request.method !== "POST" ||
      !secret ||
      url.pathname !== `/webhook/${secret}`
    ) {
      return new Response("Not found", { status: 404 });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    if (update.message) {
      ctx.waitUntil(
        handleMessage(update.message, env).catch(error => {
          console.error("Message handler failed:", error?.stack || error);
        })
      );
    }

    return new Response("OK");
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runReminders(env).catch(error => {
        console.error("Reminder scheduler failed:", error?.stack || error);
      })
    );
  }
};

// =====================================================
// BASIC HELPERS
// =====================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  })[char]);
}

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/\.$/, "");
}

function validDomain(value) {
  const domain = normalizeDomain(value);

  if (
    domain.length < 3 ||
    domain.length > 253 ||
    !domain.includes(".")
  ) {
    return false;
  }

  return domain.split(".").every(label =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function tenantIdForChat(chatId) {
  return `tg_${String(chatId).replace(/-/g, "n")}`;
}

function actorId(message) {
  return String(message.from?.id ?? "unknown");
}

function isAdmin(message, env) {
  const ids = String(
    env.ADMIN_TELEGRAM_ID || env.ADMIN_TELEGRAM_IDS || ""
  )
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  return ids.includes(actorId(message));
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function timezone(env) {
  return env.APP_TIMEZONE || DEFAULT_TIMEZONE;
}

// =====================================================
// TELEGRAM API
// =====================================================

async function tg(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram API error ${response.status}`
    );
  }

  return result.result;
}

async function send(env, chatId, text) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

// =====================================================
// DATABASE
// =====================================================

async function ensureChat(message, env) {
  const chatId = String(message.chat.id);
  const tenantId = tenantIdForChat(chatId);
  const chatType = message.chat.type || "private";
  const title =
    message.chat.title ||
    [message.chat.first_name, message.chat.last_name]
      .filter(Boolean)
      .join(" ") ||
    "Private chat";

  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id) VALUES (?)"
  ).bind(tenantId).run();

  await env.DB.prepare(`
    INSERT INTO chats (chat_id, tenant_id, chat_type, title)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title = excluded.title,
      chat_type = excluded.chat_type
  `).bind(chatId, tenantId, chatType, title).run();

  return { chatId, tenantId, chatType, title };
}

async function logAction(
  env, tenantId, chatId, actor, action, details = ""
) {
  await env.DB.prepare(`
    INSERT INTO audit_logs
      (tenant_id, chat_id, actor_id, action, details)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    tenantId,
    chatId,
    actor,
    action,
    String(details).slice(0, 1000)
  ).run();
}

async function logSheetSync(
  env, tenantId, chatId, target, status, details = ""
) {
  await env.DB.prepare(`
    INSERT INTO sheet_sync_logs
      (tenant_id, chat_id, target, status, details)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    tenantId,
    chatId || null,
    target,
    status,
    String(details).slice(0, 1000)
  ).run();
}

// =====================================================
// DATE CALCULATIONS
// =====================================================

function dateInTimezone(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function daysUntil(expiryDate, tz) {
  const today = dateInTimezone(new Date(), tz);

  return Math.round(
    (
      Date.parse(`${expiryDate}T00:00:00Z`) -
      Date.parse(`${today}T00:00:00Z`)
    ) / 86400000
  );
}

// =====================================================
// HELP
// =====================================================

function helpText() {
  return `<b>Domain Expiry Reminder</b>

<b>Tambah satu domain</b>
<code>/add example.com 2027-03-15 Cloudflare</code>

<b>Import banyak domain (maks. 25)</b>
<code>/import
example.com | 2027-03-15 | Cloudflare
myshop.net | 2027-04-20 | Namecheap</code>

<b>Perintah domain</b>
/add — tambah domain
/import — import banyak domain
/list — semua domain
/check — domain expiry dalam 30 hari atau yang sudah lewat
/detail domain.com — detail domain
/edit domain.com YYYY-MM-DD — ubah expiry
/renew domain.com YYYY-MM-DD — perpanjangan
/delete domain.com — hapus domain
/rdap domain.com — informasi RDAP
/help — bantuan

<b>Perintah admin</b>
/admin_sheet — sinkronisasi master dan Sheet grup
/admin_sheet <URL atau ID Sheet grup> — hubungkan Sheet khusus grup

<b>Reminder otomatis</b>
H-30, H-14, H-7, H-3, H-1 dan H-0.

Tambahkan bot ke grup tempat reminder ingin dikirim.`;
}

// =====================================================
// MESSAGE HANDLER
// =====================================================

async function handleMessage(message, env) {
  if (!message?.text || !message.chat?.id) return;

  const text = message.text.trim();
  const match = text.match(/^\/([a-z_]+)(?:@\w+)?\b/i);

  if (!match) return;

  const cmd = match[1].toLowerCase();
  const args = text.slice(match[0].length).trim();

  try {
    const chat = await ensureChat(message, env);
    const { chatId, tenantId } = chat;
    const actor = actorId(message);

    if (cmd === "start" || cmd === "help") {
      return await send(env, chatId, helpText());
    }

    // -------------------------------------------------
    // IMPORT
    // -------------------------------------------------

    if (cmd === "import") {
      const rows = args
        .split(/\r?\n/)
        .map(row => row.trim())
        .filter(Boolean);

      if (!rows.length) {
        return await send(
          env,
          chatId,
          `Format import:
<code>/import
example.com | 2027-03-15 | Cloudflare
myshop.net | 2027-04-20 | Namecheap</code>`
        );
      }

      if (rows.length > MAX_IMPORT_ROWS) {
        return await send(
          env,
          chatId,
          `Import ditolak. Maksimal ${MAX_IMPORT_ROWS} domain per pesan.`
        );
      }

      const current = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM domains WHERE tenant_id = ?"
      ).bind(tenantId).first();

      const limit = Math.max(
        1,
        Number(env.MAX_DOMAINS_PER_TENANT || 500)
      );

      let remaining = Math.max(
        0,
        limit - Number(current?.n || 0)
      );

      let added = 0;
      const duplicates = [];
      const invalid = [];
      const overLimit = [];

      for (let index = 0; index < rows.length; index++) {
        const parts = rows[index].split("|").map(v => v.trim());

        if (parts.length < 3) {
          invalid.push(
            `${index + 1}. Format: domain | YYYY-MM-DD | registrar`
          );
          continue;
        }

        const domain = normalizeDomain(parts[0]);
        const expiry = parts[1];
        const registrar = parts.slice(2).join(" | ") || "Unknown";

        if (!validDomain(domain) || !validDate(expiry)) {
          invalid.push(
            `${index + 1}. ${parts[0]} — domain/tanggal tidak valid`
          );
          continue;
        }

        if (remaining <= 0) {
          overLimit.push(domain);
          continue;
        }

        try {
          await env.DB.prepare(`
            INSERT INTO domains
              (tenant_id, chat_id, domain, expiry_date, registrar, created_by)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            tenantId, chatId, domain, expiry, registrar, actor
          ).run();

          added++;
          remaining--;

          await logAction(
            env,
            tenantId,
            chatId,
            actor,
            "domain_import",
            `${domain}|${expiry}|${registrar}`
          );
        } catch (error) {
          if (/unique|constraint/i.test(String(error))) {
            duplicates.push(domain);
          } else {
            throw error;
          }
        }
      }

      if (added) {
        await syncTenant(env, tenantId, chatId);
      }

      const lines = [
        "<b>Import selesai</b>",
        `Berhasil ditambahkan: ${added}/${rows.length}`
      ];

      if (duplicates.length) {
        lines.push(
          "\n<b>Duplikat (tidak ditimpa):</b>\n" +
          duplicates.map(esc).join("\n")
        );
      }

      if (invalid.length) {
        lines.push(
          "\n<b>Baris tidak valid:</b>\n" +
          invalid.map(esc).join("\n")
        );
      }

      if (overLimit.length) {
        lines.push(
          "\n<b>Melebihi batas akun:</b>\n" +
          overLimit.map(esc).join("\n")
        );
      }

      return await send(env, chatId, lines.join("\n"));
    }

    // -------------------------------------------------
    // ADD
    // -------------------------------------------------

    if (cmd === "add") {
      const parts = args.split(/\s+/);
      const domain = normalizeDomain(parts[0]);
      const expiry = parts[1];
      const registrar = parts.slice(2).join(" ") || "Unknown";

      if (!validDomain(domain) || !validDate(expiry)) {
        return await send(
          env,
          chatId,
          "Format: <code>/add domain.com YYYY-MM-DD Registrar</code>"
        );
      }

      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM domains WHERE tenant_id = ?"
      ).bind(tenantId).first();

      const limit = Math.max(
        1,
        Number(env.MAX_DOMAINS_PER_TENANT || 500)
      );

      if (Number(count?.n || 0) >= limit) {
        return await send(
          env,
          chatId,
          "Batas domain tenant sudah tercapai."
        );
      }

      try {
        await env.DB.prepare(`
          INSERT INTO domains
            (tenant_id, chat_id, domain, expiry_date, registrar, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          tenantId, chatId, domain, expiry, registrar, actor
        ).run();
      } catch (error) {
        if (/unique|constraint/i.test(String(error))) {
          return await send(
            env,
            chatId,
            `Domain <b>${esc(domain)}</b> sudah ada. Gunakan /edit atau /renew.`
          );
        }

        throw error;
      }

      await logAction(
        env, tenantId, chatId, actor,
        "domain_add", `${domain}|${expiry}|${registrar}`
      );

      await syncTenant(env, tenantId, chatId);

      return await send(
        env,
        chatId,
        `Domain ditambahkan: <b>${esc(domain)}</b>
Expiry: ${expiry}
Registrar: ${esc(registrar)}`
      );
    }

    // -------------------------------------------------
    // LIST AND CHECK
    // -------------------------------------------------

    if (cmd === "list" || cmd === "check") {
      const result = await env.DB.prepare(`
        SELECT domain, expiry_date, registrar
        FROM domains
        WHERE tenant_id = ?
        ORDER BY expiry_date ASC, domain ASC
      `).bind(tenantId).all();

      let domains = result.results || [];

      if (cmd === "check") {
        domains = domains.filter(domain =>
          daysUntil(domain.expiry_date, timezone(env)) <= 30
        );
      }

      if (!domains.length) {
        return await send(
          env,
          chatId,
          cmd === "check"
            ? "Tidak ada domain yang kedaluwarsa dalam 30 hari."
            : "Belum ada domain. Tambahkan dengan /add atau /import."
        );
      }

      const shown = domains.slice(0, 60).map(domain => {
        const days = daysUntil(domain.expiry_date, timezone(env));

        const status = days < 0
          ? `lewat ${Math.abs(days)} hari`
          : days === 0
            ? "hari ini"
            : `${days} hari lagi`;

        return `• <b>${esc(domain.domain)}</b> — ${domain.expiry_date} (${status}) · ${esc(domain.registrar)}`;
      });

      return await send(
        env,
        chatId,
        `<b>${cmd === "check" ? "Perlu diperhatikan" : "Daftar domain"} (${domains.length})</b>
${shown.join("\n")}${domains.length > 60 ? "\n…dan lainnya" : ""}`
      );
    }

    // -------------------------------------------------
    // DETAIL
    // -------------------------------------------------

    if (cmd === "detail") {
      const domain = normalizeDomain(args.split(/\s+/)[0]);

      if (!validDomain(domain)) {
        return await send(
          env,
          chatId,
          "Format: <code>/detail domain.com</code>"
        );
      }

      const item = await env.DB.prepare(`
        SELECT domain, expiry_date, registrar, created_at, updated_at
        FROM domains
        WHERE tenant_id = ? AND domain = ?
      `).bind(tenantId, domain).first();

      if (!item) {
        return await send(
          env, chatId, `Domain ${esc(domain)} tidak ditemukan.`
        );
      }

      const days = daysUntil(item.expiry_date, timezone(env));
      const remaining = days < 0
        ? `lewat ${Math.abs(days)} hari`
        : days === 0
          ? "kedaluwarsa hari ini"
          : `${days} hari lagi`;

      return await send(
        env,
        chatId,
        `<b>${esc(item.domain)}</b>
Expiry: ${item.expiry_date}
Status: ${remaining}
Registrar: ${esc(item.registrar)}
Dibuat: ${item.created_at}
Diubah: ${item.updated_at}`
      );
    }

    // -------------------------------------------------
    // EDIT AND RENEW
    // -------------------------------------------------

    if (cmd === "edit" || cmd === "renew") {
      const parts = args.split(/\s+/);
      const domain = normalizeDomain(parts[0]);
      const expiry = parts[1];
      const registrar = parts.slice(2).join(" ");

      if (!validDomain(domain) || !validDate(expiry)) {
        return await send(
          env,
          chatId,
          `Format: <code>/${cmd} domain.com YYYY-MM-DD</code>` +
          (cmd === "edit" ? " [Registrar]" : "")
        );
      }

      const existing = await env.DB.prepare(`
        SELECT id, registrar
        FROM domains
        WHERE tenant_id = ? AND domain = ?
      `).bind(tenantId, domain).first();

      if (!existing) {
        return await send(
          env, chatId, `Domain ${esc(domain)} tidak ditemukan.`
        );
      }

      await env.DB.prepare(`
        UPDATE domains
        SET expiry_date = ?,
            registrar = ?,
            updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?
      `).bind(
        expiry,
        registrar || existing.registrar,
        existing.id,
        tenantId
      ).run();

      await logAction(
        env, tenantId, chatId, actor,
        cmd, `${domain}|${expiry}`
      );

      await syncTenant(env, tenantId, chatId);

      return await send(
        env,
        chatId,
        `Data <b>${esc(domain)}</b> diperbarui.
Expiry baru: ${expiry}`
      );
    }

    // -------------------------------------------------
    // DELETE
    // -------------------------------------------------

    if (cmd === "delete") {
      const domain = normalizeDomain(args.split(/\s+/)[0]);

      if (!validDomain(domain)) {
        return await send(
          env,
          chatId,
          "Format: <code>/delete domain.com</code>"
        );
      }

      const result = await env.DB.prepare(`
        DELETE FROM domains
        WHERE tenant_id = ? AND domain = ?
      `).bind(tenantId, domain).run();

      if (!result.meta?.changes) {
        return await send(
          env, chatId, `Domain ${esc(domain)} tidak ditemukan.`
        );
      }

      await logAction(
        env, tenantId, chatId, actor, "domain_delete", domain
      );

      await syncTenant(env, tenantId, chatId);

      return await send(
        env, chatId, `Domain <b>${esc(domain)}</b> dihapus.`
      );
    }

    // -------------------------------------------------
    // RDAP
    // -------------------------------------------------

    if (cmd === "rdap") {
      const domain = normalizeDomain(args.split(/\s+/)[0]);

      if (!validDomain(domain)) {
        return await send(
          env, chatId, "Format: <code>/rdap domain.com</code>"
        );
      }

      const info = await rdapLookup(domain);

      return await send(
        env,
        chatId,
        info
          ? `<b>RDAP: ${esc(domain)}</b>
${esc(info)}

Data RDAP hanya referensi. Tanggal reminder tidak diubah otomatis.`
          : `Data RDAP tidak ditemukan untuk ${esc(domain)} atau TLD belum mendukung RDAP.`
      );
    }

    // -------------------------------------------------
    // ADMIN
    // -------------------------------------------------

    if (cmd === "admin_sheet" || cmd === "sheetmap") {
      if (!isAdmin(message, env)) {
        return await send(env, chatId, "Perintah ini khusus admin.");
      }
      if (!env.SHEETS_WEB_APP_URL || !env.SHEETS_SYNC_SECRET) {
        return await send(env, chatId, "Konfigurasi Sheets belum lengkap. Atur SHEETS_WEB_APP_URL dan SHEETS_SYNC_SECRET di Worker.");
      }
      if (args) {
        const spreadsheetId = extractSpreadsheetId(args);
        if (!spreadsheetId) {
          return await send(env, chatId, "Format salah. Kirim /admin_sheet <ID atau URL Google Sheets>.");
        }
        await env.DB.prepare(`
          INSERT INTO chat_sheets (chat_id, tenant_id, spreadsheet_id, created_by, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(chat_id) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            spreadsheet_id = excluded.spreadsheet_id,
            created_by = excluded.created_by,
            updated_at = datetime('now')
        `).bind(String(chatId), String(tenantId), spreadsheetId, String(actorId(message))).run();
      }
      const sync = await syncTenant(env, tenantId, chatId);
      if (!sync.ok) {
        return await send(env, chatId, "❌ Sinkronisasi Google Sheets gagal. Detail: " + esc(sync.error || "unknown") + ". Cek Worker Logs dan Apps Script deployment.");
      }
      const groupLine = sync.groupSynced
        ? "\nSheet grup: tersinkron (" + esc(sync.groupSpreadsheetId) + ")"
        : "\nSheet grup belum dihubungkan. Buat Google Sheets khusus grup, lalu kirim /admin_sheet <URL atau ID Sheet>.";
      return await send(env, chatId, "✅ <b>Google Sheets tersinkron!</b>\nMaster: " + esc(sync.masterTab || "OK") + "\nJumlah domain master: " + sync.count + groupLine);
    }

    return await send(
      env, chatId, "Perintah tidak dikenal. Ketik /help."
    );

  } catch (error) {
    console.error("Bot command error:", error?.stack || error);

    try {
      await send(
        env,
        message.chat.id,
        "Terjadi error saat memproses perintah. Cek Cloudflare Worker Logs."
      );
    } catch (sendError) {
      console.error("Error notification failed:", String(sendError));
    }
  }
}

// =====================================================
// AUTOMATIC REMINDERS
// =====================================================

async function runReminders(env) {
  const result = await env.DB.prepare(`
    SELECT chat_id, tenant_id, timezone
    FROM chats
  `).all();

  for (const chat of result.results || []) {
    const domains = await env.DB.prepare(`
      SELECT id, domain, expiry_date, registrar
      FROM domains
      WHERE tenant_id = ?
    `).bind(chat.tenant_id).all();

    for (const domain of domains.results || []) {
      const days = daysUntil(
        domain.expiry_date,
        chat.timezone || timezone(env)
      );

      if (!REMINDER_DAYS.includes(days)) continue;

      const existing = await env.DB.prepare(`
        SELECT id
        FROM reminder_logs
        WHERE domain_id = ?
          AND chat_id = ?
          AND expiry_date = ?
          AND reminder_day = ?
      `).bind(
        domain.id,
        chat.chat_id,
        domain.expiry_date,
        days
      ).first();

      if (existing) continue;

      const phrase = days === 0
        ? "KEDALUWARSA HARI INI"
        : `kedaluwarsa dalam ${days} hari`;

      try {
        await send(
          env,
          chat.chat_id,
          `⏰ <b>Domain expiry reminder</b>
<b>${esc(domain.domain)}</b> akan ${phrase}.
Tanggal: ${domain.expiry_date}
Registrar: ${esc(domain.registrar)}

Jika sudah diperpanjang, gunakan:
<code>/renew ${esc(domain.domain)} YYYY-MM-DD</code>`
        );

        await env.DB.prepare(`
          INSERT OR IGNORE INTO reminder_logs
            (domain_id, chat_id, expiry_date, reminder_day)
          VALUES (?, ?, ?, ?)
        `).bind(
          domain.id,
          chat.chat_id,
          domain.expiry_date,
          days
        ).run();

      } catch (error) {
        console.error(
          "Reminder send failed:",
          chat.chat_id,
          domain.domain,
          String(error)
        );
      }
    }
  }
}

function extractSpreadsheetId(input) {
  const value = String(input || "").trim();
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const id = match ? match[1] : value;
  return /^[a-zA-Z0-9_-]{20,}$/.test(id) ? id : "";
}

// =====================================================
// GOOGLE SHEETS SYNC
// =====================================================

async function syncTenant(env, tenantId, chatId) {
  if (!env.SHEETS_WEB_APP_URL || !env.SHEETS_SYNC_SECRET) {
    const message = "SHEETS_WEB_APP_URL atau SHEETS_SYNC_SECRET belum diatur.";
    await logSheetSync(env, tenantId, chatId, "apps_script", "error", message);
    return { ok: false, error: message };
  }
  try {
    const chat = await env.DB.prepare(
      "SELECT title, chat_type FROM chats WHERE chat_id = ? AND tenant_id = ?"
    ).bind(String(chatId), String(tenantId)).first();
    const result = await env.DB.prepare(`
      SELECT id, tenant_id, domain, expiry_date, registrar FROM domains
      WHERE tenant_id = ? ORDER BY expiry_date ASC, domain ASC
    `).bind(tenantId).all();
    const domains = (result.results || []).map(item => ({
      id: String(item.id), tenant_id: String(item.tenant_id), domain: item.domain,
      expiry_date: item.expiry_date, registrar: item.registrar || "Unknown", status: "active"
    }));
    const basePayload = {
      secret: env.SHEETS_SYNC_SECRET, action: "sync_domains",
      tenant_id: String(tenantId), chat_id: String(chatId),
      chat_title: String(chat?.title || "Telegram Chat"),
      chat_type: String(chat?.chat_type || "private")
    };
    const postSync = async (targetSpreadsheetId, items) => {
      const payload = { ...basePayload, domains: items };
      if (targetSpreadsheetId) payload.target_spreadsheet_id = targetSpreadsheetId;
      const response = await fetch(env.SHEETS_WEB_APP_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error("Apps Script returned non-JSON (HTTP " + response.status + ")."); }
      if (!response.ok || data.ok !== true) {
        throw new Error("Apps Script sync failed: " + String(data.error || response.status).slice(0, 250));
      }
      return data;
    };
    const master = await postSync(null, domains);
    await logSheetSync(env, tenantId, chatId, "apps_script_master", "success",
      "Tab: " + (master.tab || "unknown") + "; domains: " + domains.length);
    const mapping = await env.DB.prepare(
      "SELECT spreadsheet_id FROM chat_sheets WHERE chat_id = ? AND tenant_id = ?"
    ).bind(String(chatId), String(tenantId)).first();
    if (!mapping?.spreadsheet_id) {
      return { ok: true, count: domains.length, masterTab: master.tab, groupSynced: false };
    }
    const groupResult = await env.DB.prepare(`
      SELECT id, tenant_id, domain, expiry_date, registrar FROM domains
      WHERE tenant_id = ? AND chat_id = ? ORDER BY expiry_date ASC, domain ASC
    `).bind(tenantId, String(chatId)).all();
    const groupDomains = (groupResult.results || []).map(item => ({
      id: String(item.id), tenant_id: String(item.tenant_id), domain: item.domain,
      expiry_date: item.expiry_date, registrar: item.registrar || "Unknown", status: "active"
    }));
    await postSync(mapping.spreadsheet_id, groupDomains);
    await logSheetSync(env, tenantId, chatId, "apps_script_group", "success",
      "Spreadsheet: " + mapping.spreadsheet_id + "; domains: " + groupDomains.length);
    return { ok: true, count: domains.length, masterTab: master.tab,
      groupSynced: true, groupSpreadsheetId: mapping.spreadsheet_id, groupCount: groupDomains.length };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 400);
    await logSheetSync(env, tenantId, chatId, "apps_script", "error", message);
    console.error("Google Sheets sync failed:", message);
    return { ok: false, error: message };
  }
}

// =====================================================
// RDAP LOOKUP
// =====================================================

async function rdapLookup(domain) {
  try {
    const bootstrapResponse = await fetch(
      "https://data.iana.org/rdap/dns.json"
    );

    if (!bootstrapResponse.ok) return null;

    const bootstrap = await bootstrapResponse.json();
    const tld = domain.split(".").pop().toLowerCase();
    let base = null;

    for (const item of bootstrap.services || []) {
      const tlds = (item[0] || []).map(value => value.toLowerCase());

      if (tlds.includes(tld)) {
        base = item[1]?.[0];
        break;
      }
    }

    if (!base) return null;

    const response = await fetch(
      `${base.replace(/\/+$/, "")}/domain/${encodeURIComponent(domain)}`,
      {
        headers: {
          accept: "application/rdap+json, application/json"
        }
      }
    );

    if (!response.ok) return null;

    const data = await response.json();

    const expiryEvent = (data.events || []).find(event =>
      /expiration/i.test(event.eventAction || "")
    );

    const registrarEntity = (data.entities || []).find(entity =>
      (entity.roles || []).includes("registrar")
    );

    const vcard = registrarEntity?.vcardArray?.[1] || [];
    const nameEntry = vcard.find(entry => entry[0] === "fn");
    const registrar = nameEntry?.[3];

    return `Tanggal expiry RDAP: ${
      expiryEvent?.eventDate
        ? expiryEvent.eventDate.slice(0, 10)
        : "tidak disediakan"
    }
Registrar RDAP: ${registrar || "tidak disediakan"}`;

  } catch (error) {
    console.error("RDAP lookup error:", String(error));
    return null;
  }
}
