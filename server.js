// server.js — Backend DzzXNzz
// Tidak perlu .env — semua config dari config.js
// Install: npm install express node-fetch cors
// Jalankan: node server.js

const express = require('express');
const app     = express();

// Load config dari /var/www/html/config.js
const { CONFIG } = require('/var/www/html/config.js');

app.use(express.json());
app.use(require('cors')({ origin: '*' }));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── SUPABASE HELPER ───────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const { fetch } = await import('node-fetch');
  const key = opts.useService ? CONFIG.SUPABASE_SERVICE : CONFIG.SUPABASE_ANON;
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
async function verifyToken(token) {
  try {
    const decoded  = Buffer.from(token, 'base64').toString('utf8');
    const [username] = decoded.split(':');
    if (!username) return null;
    const { ok, data } = await sb(`/profiles?username=eq.${username}&select=id,username,coins`);
    if (!ok || !data?.length) return null;
    return data[0];
  } catch { return null; }
}

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const user = await verifyToken(header.replace('Bearer ', ''));
  if (!user) return res.status(401).json({ error: 'Token tidak valid' });
  req.user = user;
  next();
}

function genOrderId() {
  return `DZZ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2,5).toUpperCase()}`;
}

// ── POST /api/create-transaction ─────────────────────────────────────────────
app.post('/api/create-transaction', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    const user = req.user;

    if (!amount || isNaN(amount) || amount < CONFIG.MIN_TOPUP)
      return res.status(400).json({ error: `Minimal top up Rp ${CONFIG.MIN_TOPUP.toLocaleString('id-ID')}` });
    if (amount > 10_000_000)
      return res.status(400).json({ error: 'Maksimal top up Rp 10.000.000' });

    const order_id = genOrderId();
    const { fetch } = await import('node-fetch');

    // Buat transaksi ke Pakasir
    const pkRes  = await fetch(CONFIG.PAKASIR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.PAKASIR_API_KEY}` },
      body: JSON.stringify({
        project:     CONFIG.PAKASIR_PROJECT,
        order_id,
        amount,
        description: `Topup DzzXNzz - ${user.username}`,
        customer:    user.username,
      }),
    });
    const pkData = await pkRes.json();

    if (!pkRes.ok) {
      console.error('Pakasir error:', pkData);
      return res.status(502).json({ error: 'Gagal buat transaksi QRIS', detail: pkData });
    }

    // Simpan ke Supabase
    const tx = {
      order_id,
      user_id:     user.id,
      username:    user.username,
      amount,                              // amount rupiah = coins yang masuk
      status:      'pending',
      qr_string:   pkData.qr_string  || pkData.data?.qr_string  || null,
      qr_image:    pkData.qr_image   || pkData.data?.qr_image   || null,
      pakasir_ref: pkData.ref        || pkData.data?.ref        || null,
      created_at:  new Date().toISOString(),
      expires_at:  new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };

    await sb('/transactions', { method: 'POST', body: JSON.stringify(tx), useService: true });
    console.log(`[TX] ${order_id} | ${user.username} | Rp ${amount}`);

    res.json({ order_id, amount, qr_string: tx.qr_string, qr_image: tx.qr_image, expires_at: tx.expires_at });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/transaction/:order_id ───────────────────────────────────────────
app.get('/api/transaction/:order_id', auth, async (req, res) => {
  try {
    const { ok, data } = await sb(
      `/transactions?order_id=eq.${req.params.order_id}&user_id=eq.${req.user.id}&select=order_id,amount,status,qr_string,qr_image,created_at,expires_at`
    );
    if (!ok || !data?.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/transaction/:order_id/status ────────────────────────────────────
app.get('/api/transaction/:order_id/status', auth, async (req, res) => {
  try {
    const { ok, data } = await sb(
      `/transactions?order_id=eq.${req.params.order_id}&user_id=eq.${req.user.id}&select=status,amount`
    );
    if (!ok || !data?.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

    const tx = data[0];

    // Kalau masih pending, cek langsung ke Pakasir
    if (tx.status === 'pending') {
      try {
        const { fetch } = await import('node-fetch');
        const ck = await fetch(`${CONFIG.PAKASIR_STATUS}/${req.params.order_id}`, {
          headers: { 'Authorization': `Bearer ${CONFIG.PAKASIR_API_KEY}` }
        });
        const ckData = await ck.json();
        const st = ckData.status || ckData.data?.status;
        if (st === 'paid' || st === 'success') {
          await processPayment(req.params.order_id, req.user.id, tx.amount);
          return res.json({ status: 'paid', amount: tx.amount });
        }
      } catch(e) { /* pakai status dari db */ }
    }

    res.json({ status: tx.status, amount: tx.amount });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/transaction/:order_id/cancel ───────────────────────────────────
app.post('/api/transaction/:order_id/cancel', auth, async (req, res) => {
  try {
    const { ok, data } = await sb(
      `/transactions?order_id=eq.${req.params.order_id}&user_id=eq.${req.user.id}&select=order_id,status`
    );
    if (!ok || !data?.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    if (data[0].status !== 'pending') return res.status(400).json({ error: 'Tidak bisa dibatalkan' });

    await sb(`/transactions?order_id=eq.${req.params.order_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled', cancelled_at: new Date().toISOString() }),
      useService: true,
    });

    console.log(`[CANCEL] ${req.params.order_id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/webhook/pakasir ─────────────────────────────────────────────────
app.post('/api/webhook/pakasir', async (req, res) => {
  try {
    console.log('[WEBHOOK]', JSON.stringify(req.body));

    // Verifikasi secret
    const secret = req.headers['x-webhook-secret'] || req.headers['authorization'];
    if (secret !== CONFIG.WEBHOOK_SECRET && secret !== `Bearer ${CONFIG.WEBHOOK_SECRET}`) {
      console.warn('[WEBHOOK] Secret tidak cocok');
      return res.status(401).json({ error: 'Invalid secret' });
    }

    const order_id = req.body.order_id || req.body.data?.order_id;
    const status   = req.body.status   || req.body.data?.status;

    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    if (status === 'paid' || status === 'success') {
      const { ok, data } = await sb(
        `/transactions?order_id=eq.${order_id}&select=order_id,user_id,amount,status`
      );
      if (!ok || !data?.length) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

      const tx = data[0];
      if (tx.status === 'paid') return res.json({ ok: true, message: 'Already processed' });

      await processPayment(order_id, tx.user_id, tx.amount);
      console.log(`[WEBHOOK] Paid: ${order_id} | +${tx.amount} coins`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── HELPER: processPayment ────────────────────────────────────────────────────
// amount rupiah = coins yang ditambahkan (1 rupiah = 1 coin)
async function processPayment(order_id, user_id, amount) {
  // Update status transaksi
  await sb(`/transactions?order_id=eq.${order_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'paid', paid_at: new Date().toISOString() }),
    useService: true,
  });

  // Ambil coins sekarang
  const { data } = await sb(`/profiles?id=eq.${user_id}&select=id,coins`);
  if (!data?.length) return console.error(`[processPayment] User tidak ditemukan: ${user_id}`);

  // Tambah coins: 1 rupiah = 1 coin
  const newCoins = (Number(data[0].coins) || 0) + Number(amount);
  await sb(`/profiles?id=eq.${user_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ coins: newCoins }),
    useService: true,
  });

  console.log(`[COINS] user=${user_id} | +${amount} | total=${newCoins}`);
}

// ── GET /api/transactions (riwayat) ──────────────────────────────────────────
app.get('/api/transactions', auth, async (req, res) => {
  try {
    const { data } = await sb(
      `/transactions?user_id=eq.${req.user.id}&select=order_id,amount,status,created_at,paid_at&order=created_at.desc&limit=20`
    );
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 DzzXNzz Backend jalan di port ${CONFIG.PORT}`);
  console.log(`   Health : http://localhost:${CONFIG.PORT}/api/health`);
  console.log(`   Webhook: http://IP_VPS/api/webhook/pakasir\n`);
});
