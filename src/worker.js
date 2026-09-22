// WX Saweria Worker — versi milikmu sendiri
// Menjembatani webhook Saweria <-> game Roblox lewat pola pull/ack.
//
// Endpoint:
//   POST /saweria    <- dipanggil oleh Saweria (webhook)
//   POST /api/pull   <- dipanggil oleh server Roblox (polling)
//   POST /api/ack    <- dipanggil oleh server Roblox (konfirmasi terkirim)

const QUEUE_KEY = "queue";
const LEASED_KEY = "leased";
const LEASE_TTL_MS = 45_000; // kalau Roblox tidak ack dalam 45 detik, donasi dikembalikan ke antrian
const MAX_QUEUE = 500;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function getQueue(env) {
  const raw = await env.SAWERIA_KV.get(QUEUE_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function setQueue(env, queue) {
  await env.SAWERIA_KV.put(QUEUE_KEY, JSON.stringify(queue));
}
async function getLeased(env) {
  const raw = await env.SAWERIA_KV.get(LEASED_KEY);
  return raw ? JSON.parse(raw) : {};
}
async function setLeased(env, leased) {
  await env.SAWERIA_KV.put(LEASED_KEY, JSON.stringify(leased));
}

// Perbandingan string tahan-timing-attack, dipakai untuk cek signature webhook.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleWebhook(request, env) {
  const signature = request.headers.get("saweria-callback-signature") || "";
  const bodyText = await request.text();

  // Kalau kamu sudah set secret SAWERIA_STREAM_KEY, request wajib punya signature yang cocok.
  if (env.SAWERIA_STREAM_KEY) {
    if (!signature) return json({ ok: false, error: "missing_signature" }, 403);
    if (!safeEqual(signature, env.SAWERIA_STREAM_KEY)) {
      return json({ ok: false, error: "invalid_signature" }, 401);
    }
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (payload.type && payload.type !== "donation") {
    return json({ ok: true, skipped: true });
  }

  const donation = {
    id: payload.id || crypto.randomUUID(),
    username: payload.donator_name || payload.donatorName || "Anonymous",
    amount: Number(payload.amount_raw ?? payload.amountRaw ?? payload.amount ?? 0),
    message: payload.message || "",
    createdAt: payload.created_at || payload.createdAt || new Date().toISOString(),
    isFake: false,
  };

  if (!donation.amount || donation.amount <= 0) {
    return json({ ok: true, skipped: true });
  }

  const queue = await getQueue(env);
  if (queue.some((item) => item.id === donation.id)) {
    return json({ ok: true, duplicate: true });
  }
  queue.push(donation);
  while (queue.length > MAX_QUEUE) queue.shift();
  await setQueue(env, queue);

  return json({ ok: true });
}

async function handlePull(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // biarkan default {}
  }
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 25);

  const queue = await getQueue(env);
  const leased = await getLeased(env);

  // Ambil kembali donasi yang sudah lama di-lease tapi tak kunjung di-ack (server Roblox mungkin restart/putus).
  const now = Date.now();
  for (const [id, entry] of Object.entries(leased)) {
    if (now - entry.leasedAt > LEASE_TTL_MS) {
      queue.push(entry.donation);
      delete leased[id];
    }
  }

  const items = [];
  while (items.length < limit && queue.length > 0) {
    const donation = queue.shift();
    const leaseToken = crypto.randomUUID();
    leased[donation.id] = { donation, leaseToken, leasedAt: now };
    items.push({ ...donation, leaseToken });
  }

  await setQueue(env, queue);
  await setLeased(env, leased);

  return json({ ok: true, items });
}

async function handleAck(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const items = Array.isArray(body.items) ? body.items : [];

  const leased = await getLeased(env);
  const queue = await getQueue(env);

  for (const item of items) {
    const entry = leased[item.id];
    if (!entry || entry.leaseToken !== item.leaseToken) continue;
    if (item.status === "done") {
      delete leased[item.id];
    } else {
      // gagal dikirim -> kembalikan ke antrian supaya dicoba lagi
      queue.push(entry.donation);
      delete leased[item.id];
    }
  }

  await setLeased(env, leased);
  await setQueue(env, queue);

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return json({ ok: true });
    }
    if (url.pathname === "/saweria" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    if (url.pathname === "/api/pull" && request.method === "POST") {
      return handlePull(request, env);
    }
    if (url.pathname === "/api/ack" && request.method === "POST") {
      return handleAck(request, env);
    }
    if (url.pathname === "/") {
      return json({ ok: true, service: "wx-saweria-worker" });
    }
    return json({ ok: false, error: "not_found" }, 404);
  },
};
