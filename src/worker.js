const PREFIX = "don:";
const LEASE_MS = 90_000;
const MAX_ATTEMPTS = 5;
const DONE_RETENTION_MS = 60 * 60 * 1000;
const DEBUG_QUEUE_LIMIT = 200; // batas aman biar /debug/queue tidak berat kalau antrian besar

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function keyFor(id) {
  return PREFIX + id;
}

async function verifySaweriaSignature(rawBody, signatureHeader, streamKey) {
  if (!streamKey) return true; // gak di-set = skip verifikasi (aman buat testing / belum punya stream key)
  if (!signatureHeader) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(streamKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (hex.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

// Deteksi apakah payload ini adalah TEST dari tombol "Munculkan Notifikasi" Saweria.
// Saweria selalu kirim ID yang sama (00000000-0000-0000-0000-000000000000) untuk test,
// jadi kalau dedupe by ID, klik test ke-2 dst. akan di-skip.
// Untuk test, kita generate ID baru tiap kali, supaya bisa multi-test.
// Untuk donasi asli, ID Saweria selalu unik per transaksi â†’ dedupe tetap jalan.
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function isTestPayload(payload) {
  const id = String(payload.id || "").toLowerCase();
  // Klik "Munculkan Notifikasi" Saweria selalu pakai nil UUID.
  if (id === NIL_UUID) return true;
  // Cadangan: kalau besok Saweria ganti format test, deteksi via ciri khas lain.
  if (payload.amount_raw === 69420 && /FAKE MESSAGE/i.test(String(payload.message || ""))) {
    return true;
  }
  return false;
}

// Menerima donasi baru dari webhook Saweria.
// Karena tiap donasi punya key unik sendiri (don:<id>), dua donasi berbeda
// yang masuk bersamaan otomatis tidak akan saling menimpa.
async function pushItem(env, payload) {
  const testMode = isTestPayload(payload);
  // Untuk test: generate UUID baru tiap kali (bisa multi-test).
  // Untuk donasi asli: pakai ID asli Saweria (dedupe by ID).
  const id = testMode ? crypto.randomUUID() : String(payload.id);
  const key = keyFor(id);

  const existing = await env.SAWERIA_KV.get(key);
  if (existing) {
    return { ok: true, deduped: true };
  }

  const item = {
    id,
    original_id: testMode ? String(payload.id) : null, // simpan ID asli Saweria untuk traceability
    is_test: testMode,
    amount_raw: payload.amount_raw,
    donator_name: payload.donator_name,
    message: payload.message,
    created_at: payload.created_at,
    received_at: new Date().toISOString(),
    status: "pending",
    leaseToken: null,
    leaseExpires: 0,
    attempts: 0,
    lastError: "",
    doneAt: 0,
  };

  await env.SAWERIA_KV.put(key, JSON.stringify(item), {
    metadata: { status: item.status, leaseExpires: 0, doneAt: 0 },
  });

  return { ok: true, is_test: testMode };
}

// Roblox mengambil donasi yang belum terkirim.
async function pullItems(env, limit) {
  const now = Date.now();
  const out = [];
  const toCleanup = [];

  let cursor;
  do {
    const page = await env.SAWERIA_KV.list({ prefix: PREFIX, cursor, limit: 1000 });
    cursor = page.cursor;

    for (const entry of page.keys) {
      if (out.length >= limit) break;

      const meta = entry.metadata || {};
      const status = meta.status;
      const leaseExpires = Number(meta.leaseExpires || 0);
      const doneAt = Number(meta.doneAt || 0);

      // Bersihkan donasi "done" yang sudah lewat masa retensi (1 jam).
      if (status === "done" && doneAt && now - doneAt > DONE_RETENTION_MS) {
        toCleanup.push(entry.name);
        continue;
      }

      const available = status === "pending" || (status === "leased" && leaseExpires < now);
      if (!available) continue;

      const raw = await env.SAWERIA_KV.get(entry.name);
      if (!raw) continue;
      const item = JSON.parse(raw);

      // Cek ulang status terkini sebelum lease (mengurangi peluang race,
      // walau Workers KV memang tidak punya jaminan atomik penuh tanpa Durable Objects).
      const stillAvailable =
        item.status === "pending" || (item.status === "leased" && item.leaseExpires < now);
      if (!stillAvailable) continue;

      const leaseToken = crypto.randomUUID();
      item.status = "leased";
      item.leaseToken = leaseToken;
      item.leaseExpires = now + LEASE_MS;
      item.attempts += 1;

      await env.SAWERIA_KV.put(entry.name, JSON.stringify(item), {
        metadata: { status: item.status, leaseExpires: item.leaseExpires, doneAt: item.doneAt || 0 },
      });

      out.push({
        id: item.id,
        leaseToken: item.leaseToken,
        amount: item.amount_raw,
        amount_raw: item.amount_raw,
        donator_name: item.donator_name,
        message: item.message,
        is_test: item.is_test ?? false,
        original_id: item.original_id ?? null,
        createdAt: item.created_at,
        created_at: item.created_at,
      });
    }
  } while (cursor && out.length < limit);

  for (const name of toCleanup) {
    await env.SAWERIA_KV.delete(name);
  }

  return out;
}

// Roblox mengonfirmasi donasi sudah/gagal ditampilkan.
async function ackItems(env, acks) {
  for (const ack of acks) {
    const id = String(ack.id || "");
    if (!id) continue;

    const key = keyFor(id);
    const raw = await env.SAWERIA_KV.get(key);
    if (!raw) continue;
    const item = JSON.parse(raw);

    if (item.leaseToken && ack.leaseToken && item.leaseToken !== ack.leaseToken) continue;

    if (ack.status === "done") {
      item.status = "done";
      item.doneAt = Date.now();
      item.leaseToken = null;
      item.leaseExpires = 0;
    } else {
      item.status = item.attempts >= MAX_ATTEMPTS ? "dead" : "pending";
      item.leaseToken = null;
      item.leaseExpires = 0;
      item.lastError = String(ack.error || "").slice(0, 250);
    }

    await env.SAWERIA_KV.put(key, JSON.stringify(item), {
      metadata: { status: item.status, leaseExpires: item.leaseExpires, doneAt: item.doneAt || 0 },
    });
  }
}

function checkDebugAuth(request, env) {
  return env.DEBUG_TOKEN && request.headers.get("x-debug-token") === env.DEBUG_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ============================================================
    // /saweria  â€”  Webhook Saweria (donasi masuk)
    // ============================================================
    if (url.pathname === "/saweria" && request.method === "POST") {
      const rawBody = await request.text();
      const signature = request.headers.get("Saweria-Callback-Signature") || "";
      const valid = await verifySaweriaSignature(rawBody, signature, env.SAWERIA_STREAM_KEY);
      if (!valid) return json({ ok: false, error: "invalid_signature" }, 401);

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return json({ ok: false, error: "bad_json" }, 400);
      }
      if (payload.type && payload.type !== "donation") {
        return json({ ok: true, skipped: true });
      }
      if (!payload.id) {
        payload.id = crypto.randomUUID();
      }
      const amount = Number(payload.amount_raw ?? payload.amount ?? 0);
      if (!amount || amount <= 0) {
        return json({ ok: true, skipped: true });
      }

      const result = await pushItem(env, {
        id: payload.id,
        amount_raw: amount,
        donator_name: payload.donator_name,
        message: payload.message,
        created_at: payload.created_at,
      });
      // Response balik ke Saweria. is_test=true kalau ini dari tombol test.
      return json(result);
    }

    // ============================================================
    // /webhook  â€”  Endpoint Roblox (pull / ack via field "action")
    // ============================================================
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const action = String(body.action || "").toLowerCase();

      if (action === "pull") {
        const limit = Math.max(1, Math.min(25, Number(body.limit) || 10));
        const items = await pullItems(env, limit);
        return json({ ok: true, items });
      }

      if (action === "ack") {
        const acks = Array.isArray(body.items) ? body.items : [];
        await ackItems(env, acks);
        return json({ ok: true });
      }

      return json(
        {
          ok: false,
          error: "unknown_action",
          hint: 'kirim body {"action":"pull","limit":10} atau {"action":"ack","items":[...]}',
        },
        400
      );
    }

    // ============================================================
    // /api/pull & /api/ack  â€”  Alias backward-compat (lama)
    // ============================================================
    if (url.pathname === "/api/pull" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const limit = Math.max(1, Math.min(25, Number(body.limit) || 10));
      const items = await pullItems(env, limit);
      return json({ ok: true, items });
    }

    if (url.pathname === "/api/ack" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const acks = Array.isArray(body.items) ? body.items : [];
      await ackItems(env, acks);
      return json({ ok: true });
    }

    // ============================================================
    // Endpoint debug & admin (tidak berubah)
    // ============================================================
    if (url.pathname === "/debug/push" && request.method === "POST") {
      if (!checkDebugAuth(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      const payload = await request.json().catch(() => ({}));
      // Untuk multi-test: kalau id kosong atau nil-UUID, pushItem otomatis
      // generate UUID baru lewat isTestPayload detection.
      const result = await pushItem(env, {
        id: payload.id || NIL_UUID, // pakai nil-UUID â†’ otomatis masuk mode test
        amount_raw: payload.amount_raw || 5000,
        donator_name: payload.donator_name || "Tester",
        message: payload.message || "test donasi",
        created_at: payload.created_at || new Date().toISOString(),
      });
      return json(result);
    }

    if (url.pathname === "/admin/retry" && request.method === "POST") {
      if (!checkDebugAuth(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const key = keyFor(String(body.id || ""));
      const raw = await env.SAWERIA_KV.get(key);
      if (!raw) return json({ ok: false, error: "not_found" }, 404);
      const item = JSON.parse(raw);
      item.status = "pending";
      item.leaseToken = null;
      item.leaseExpires = 0;
      item.attempts = 0;
      item.lastError = "";
      await env.SAWERIA_KV.put(key, JSON.stringify(item), {
        metadata: { status: item.status, leaseExpires: 0, doneAt: 0 },
      });
      return json({ ok: true });
    }

    if (url.pathname === "/admin/delete" && request.method === "POST") {
      if (!checkDebugAuth(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const key = keyFor(String(body.id || ""));
      await env.SAWERIA_KV.delete(key);
      return json({ ok: true, removed: true });
    }

    if (url.pathname === "/debug/queue" && request.method === "GET") {
      if (!checkDebugAuth(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      const items = [];
      let cursor;
      do {
        const page = await env.SAWERIA_KV.list({ prefix: PREFIX, cursor, limit: 1000 });
        cursor = page.cursor;
        for (const entry of page.keys) {
          if (items.length >= DEBUG_QUEUE_LIMIT) break;
          const raw = await env.SAWERIA_KV.get(entry.name);
          if (raw) items.push(JSON.parse(raw));
        }
      } while (cursor && items.length < DEBUG_QUEUE_LIMIT);
      return json({ ok: true, count: items.length, items });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "wx-saweria-worker-fixed" });
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};
