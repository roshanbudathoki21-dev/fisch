const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const BRAND_NAME = 'BloxCartel';
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://bloxcartel.com';
const TRAFFIC_WEBHOOK_URL = process.env.DISCORD_TRAFFIC_WEBHOOK_URL || '';
const ORDER_WEBHOOK_URL = process.env.DISCORD_ORDER_WEBHOOK_URL || '';
const PROMO_WEBHOOK_URL = process.env.DISCORD_PROMO_WEBHOOK_URL || ORDER_WEBHOOK_URL;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'] }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const _rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 8;
  if (!_rateLimitMap.has(ip)) _rateLimitMap.set(ip, []);
  const timestamps = _rateLimitMap.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  _rateLimitMap.set(ip, timestamps);
  if (timestamps.length > maxRequests) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }
  next();
}

const clicks = {};
let direct = 0;
let totalVisits = 0;

function sendPage(res, filename) {
  const pub = path.join(__dirname, 'public', filename);
  const root = path.join(__dirname, filename);
  if (fs.existsSync(pub)) return res.sendFile(pub);
  if (fs.existsSync(root)) return res.sendFile(root);
  res.status(404).send(filename + ' not found');
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.length < 20) throw new Error('STRIPE_SECRET_KEY missing or invalid.');
  return require('stripe')(key);
}

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const stripe = getStripe();
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(400).send('Webhook secret not configured.');
    const event = stripe.webhooks.constructEvent(req.body, sig, secret);
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      console.log(`✅ Payment | $${(pi.amount / 100).toFixed(2)} | ${pi.metadata.product} | ${pi.metadata.username}`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook]', err.message);
    res.status(400).send('Webhook Error: ' + err.message);
  }
});

app.use(express.json({ limit: '10kb' }));

app.get('/', (req, res) => { direct++; totalVisits++; sendPage(res, 'index.html'); });
app.get('/ref', (req, res) => {
  const creator = String(req.query.creator || '').replace(/[^\w.-]/g, '').slice(0, 64);
  if (creator) clicks[creator] = (clicks[creator] || 0) + 1;
  totalVisits++;
  sendPage(res, 'index.html');
});
app.get('/checkout', (req, res) => sendPage(res, 'checkout.html'));
app.get('/sailor-piece', (req, res) => sendPage(res, 'sailor-piece.html'));
app.get('/aot', (req, res) => sendPage(res, 'aot.html'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/robots.txt', (req, res) => sendPage(res, 'robots.txt'));
app.get('/sitemap.xml', (req, res) => sendPage(res, 'sitemap.xml'));

if (TRAFFIC_WEBHOOK_URL) {
  setInterval(async () => {
    const refEntries = Object.entries(clicks);
    const refLines = refEntries.length > 0
      ? refEntries.sort((a, b) => b[1] - a[1]).map(([c, n]) => `🔗 **${c}** — ${n} visits`).join('\n')
      : '_(no referral visits yet)_';
    const report = ['📊 **BloxCartel Traffic Report**', '', `🌐 **Direct visits** — ${direct}`, `👥 **Total visits** — ${totalVisits}`, '', '**Referral Breakdown:**', refLines].join('\n');
    try {
      await fetch(TRAFFIC_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: report }) });
    } catch (err) {
      console.error('[report]', err.message);
    }
  }, 1000 * 60 * 60);
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.static(path.join(__dirname), { maxAge: '1h' }));

app.post('/api/create-payment-intent', rateLimit, async (req, res) => {
  try {
    const stripe = getStripe();
    const { product, username, price } = req.body;
    if (!product || !price || typeof price !== 'number' || price <= 0 || price > 10000) return res.status(400).json({ error: 'Invalid product or price.' });
    const cleanProduct = String(product).slice(0, 500);
    const cleanUsername = String(username || '(pending)').slice(0, 80);
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(price * 100),
      currency: 'usd',
      description: `${BRAND_NAME} — ${cleanProduct}`,
      metadata: { product: cleanProduct, username: cleanUsername, source: BRAND_NAME },
      automatic_payment_methods: { enabled: true }
    });
    res.json({ clientSecret: intent.client_secret, intentId: intent.id });
  } catch (err) {
    console.error('[create-payment-intent]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/update-intent-username', rateLimit, async (req, res) => {
  try {
    const stripe = getStripe();
    const { intentId, username, email } = req.body;
    if (!intentId || !username) return res.json({ ok: false });
    const meta = { username: String(username).slice(0, 80) };
    if (email) meta.email = String(email).slice(0, 120);
    await stripe.paymentIntents.update(intentId, { metadata: meta });
    res.json({ ok: true });
  } catch (err) {
    console.error('[update-intent]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/order-event', rateLimit, async (req, res) => {
  const eventId = crypto.randomUUID();
  const payload = req.body || {};
  console.log(`[order-event:${eventId}]`, JSON.stringify(payload).slice(0, 1000));
  const isPromo = JSON.stringify(payload).includes('PROMO CODE USED');
  const webhookUrl = isPromo ? PROMO_WEBHOOK_URL : ORDER_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (err) {
      console.error('[order-event webhook]', err.message);
      return res.status(502).json({ ok: false, eventId, error: 'Unable to forward order notification.' });
    }
  }
  res.json({ ok: true, eventId, forwarded: Boolean(webhookUrl) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ${BRAND_NAME} running on port ${PORT}`);
  console.log(`🌐 Public URL: ${BASE_URL}`);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) console.warn('⚠️ STRIPE_SECRET_KEY not set!'); else console.log('✅ Stripe key loaded');
  const wsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!wsec) console.warn('⚠️ STRIPE_WEBHOOK_SECRET not set!'); else console.log('✅ Stripe webhook secret loaded');
  if (!TRAFFIC_WEBHOOK_URL) console.warn('⚠️ DISCORD_TRAFFIC_WEBHOOK_URL not set; hourly traffic reports disabled.');
  if (!ORDER_WEBHOOK_URL) console.warn('⚠️ DISCORD_ORDER_WEBHOOK_URL not set; order notifications will only be logged.');
});
