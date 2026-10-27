
const REMINDER_DAYS = [30, 14, 7, 3, 1, 0];
const DEFAULT_TIMEZONE = "Asia/Kuala_Lumpur";
const MAX_IMPORT_ROWS = 25;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
/admin_sheet — informasi konfigurasi Sheets

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
        return await send(
          env, chatId, "Perintah ini khusus admin."
        );
      }

      return await send(
        env,
        chatId,
        `<b>Konfigurasi Google Sheets</b>

Master spreadsheet: ${env.MASTER_SHEET_ID ? "terpasang" : "belum diatur"}
Service account: ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? "terpasang" : "belum diatur"}
Mapping pelanggan: ${env.TENANT_SHEET_MAP_JSON ? "tersedia" : "belum diatur"}

Mapping diatur melalui Worker variable/secret TENANT_SHEET_MAP_JSON.`
      );
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

// =====================================================
// GOOGLE SHEETS SYNC
// =====================================================

async function syncTenant(env, tenantId, chatId) {
  const targets = [];

  if (env.MASTER_SHEET_ID) {
    targets.push({
      id: env.MASTER_SHEET_ID,
      tab: env.MASTER_SHEET_TAB || "Domains",
      name: "master"
    });
  }

  const mapping = parseJson(env.TENANT_SHEET_MAP_JSON || "{}");
  const customerSheetId = mapping[tenantId];

  if (customerSheetId) {
    targets.push({
      id: customerSheetId,
      tab: "Domains",
      name: "customer"
    });
  }

  if (!targets.length) {
    console.log(
      "Google Sheets sync skipped: no spreadsheet configured for",
      tenantId
    );
    return;
  }

  try {
    const result = await env.DB.prepare(`
      SELECT chat_id, domain, expiry_date, registrar, created_at, updated_at
      FROM domains
      WHERE tenant_id = ?
      ORDER BY expiry_date, domain
    `).bind(tenantId).all();

    const rows = [[
      "Tenant ID",
      "Chat ID",
      "Domain",
      "Expiry Date",
      "Registrar",
      "Created At",
      "Updated At"
    ]];

    for (const item of result.results || []) {
      rows.push([
        tenantId,
        item.chat_id,
        item.domain,
        item.expiry_date,
        item.registrar,
        item.created_at,
        item.updated_at
      ]);
    }

    for (const target of targets) {
      try {
        await writeSheet(
          env, target.id, target.tab, rows
        );

        await logSheetSync(
          env,
          tenantId,
          chatId,
          target.name,
          "success",
          `Updated ${rows.length - 1} domain rows`
        );

      } catch (error) {
        console.error(
          "Sheet sync failed:",
          target.name,
          String(error)
        );

        await logSheetSync(
          env,
          tenantId,
          chatId,
          target.name,
          "error",
          String(error)
        );
      }
    }
  } catch (error) {
    console.error("Could not prepare Sheets data:", String(error));

    await logSheetSync(
      env,
      tenantId,
      chatId,
      "google_sheets",
      "error",
      String(error)
    );
  }
}

async function signRS256(privateKeyPem, data) {
  const pem = privateKeyPem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");

  const keyBytes = Uint8Array.from(
    atob(pem),
    char => char.charCodeAt(0)
  );

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );

  return base64url(new Uint8Array(signature));
}

function base64url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function utf8Base64url(value) {
  return base64url(new TextEncoder().encode(value));
}

async function googleAccessToken(env) {
  if (
    !env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  ) {
    throw new Error("Google service account credentials missing");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = utf8Base64url(JSON.stringify({
    alg: "RS256",
    typ: "JWT"
  }));

  const claim = utf8Base64url(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));

  const unsigned = `${header}.${claim}`;
  const signature = await signRS256(
    env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    unsigned
  );

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`
      })
    }
  );

  const result = await response.json();

  if (!response.ok || !result.access_token) {
    throw new Error(
      `Google OAuth failed: ${JSON.stringify(result).slice(0, 400)}`
    );
  }

  return result.access_token;
}

async function writeSheet(env, spreadsheetId, tab, rows) {
  const token = await googleAccessToken(env);
  const safeTab = String(tab).replace(/'/g, "''");
  const baseUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/` +
    `${encodeURIComponent(spreadsheetId)}/values/`;

  const range = `'${safeTab}'!A:G`;

  // Clear the old range first so deleted domains do not remain.
  const clearResponse = await fetch(
    `${baseUrl}${encodeURIComponent(range)}:clear`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: "{}"
    }
  );

  if (!clearResponse.ok) {
    const error = await clearResponse.text();
    throw new Error(
      `Sheets clear error ${clearResponse.status}: ${error.slice(0, 300)}`
    );
  }

  const response = await fetch(
    `${baseUrl}${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        range,
        majorDimension: "ROWS",
        values: rows
      })
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Sheets API error ${response.status}: ${JSON.stringify(result).slice(0, 400)}`
    );
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
