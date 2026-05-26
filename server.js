const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());

// ── Body size limit (protect against payload attacks) ─────────────────────
app.use(express.json({ limit: '10kb' }));

// ── Simple in-memory rate limiter for /api/create-payment-intent ──────────
const _rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 8;       // max 8 payment intents per minute per IP

  if (!_rateLimitMap.has(ip)) _rateLimitMap.set(ip, []);
  const timestamps = _rateLimitMap.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  _rateLimitMap.set(ip, timestamps);

  if (timestamps.length > maxRequests) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }
  next();
}

// ── Visit & Referral tracking ─────────────────────────────────────────────
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1479014960775565383/K8HIiuRKKaSz4rt9My2O8VvoOKxvQqxE8XUd5SRQq2Wj3RKVjcBgOpx7fckUpZfaVvWT';
const clicks = {};
let direct = 0;
let totalVisits = 0;

// Helper to resolve index.html
function sendIndex(res) {
  const pub = path.join(__dirname, 'public', 'index.html');
  const root = path.join(__dirname, 'index.html');
  if (fs.existsSync(pub)) return res.sendFile(pub);
  if (fs.existsSync(root)) return res.sendFile(root);
  res.status(404).send('index.html not found');
}

// Helper to resolve checkout.html
function sendCheckout(res) {
  const pub = path.join(__dirname, 'public', 'checkout.html');
  const root = path.join(__dirname, 'checkout.html');
  if (fs.existsSync(pub)) return res.sendFile(pub);
  if (fs.existsSync(root)) return res.sendFile(root);
  res.status(404).send('checkout.html not found');
}

// ── Main site visit tracker ───────────────────────────────────────────────
app.get('/', (req, res) => {
  direct++;
  totalVisits++;
  sendIndex(res);
});

// ── Referral visit tracker ────────────────────────────────────────────────
app.get('/ref', (req, res) => {
  const creator = req.query.creator;
  if (creator) {
    clicks[creator] = (clicks[creator] || 0) + 1;
  }
  totalVisits++;
  sendIndex(res);
});

// ── Checkout page ─────────────────────────────────────────────────────────
app.get('/checkout', (req, res) => {
  sendCheckout(res);
});

// ── Sends full report to Discord every 60 minutes ─────────────────────────
setInterval(async () => {
  const refEntries = Object.entries(clicks);
  const refLines = refEntries.length > 0
    ? refEntries
        .sort((a, b) => b[1] - a[1])
        .map(([creator, count]) => `🔗 **${creator}** — ${count} visits`)
        .join('\n')
    : '_(no referral visits yet)_';

  const report = [
    `📊 **BrainrotShop Traffic Report**`,
    ``,
    `🌐 **Direct visits** (brainrotshop.fun) — ${direct}`,
    `👥 **Total visits** — ${totalVisits}`,
    ``,
    `**Referral Breakdown:**`,
    refLines
  ].join('\n');

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: report })
    });
    console.log('📊 Traffic report sent to Discord');
  } catch (err) {
    console.error('[report webhook]', err.message);
  }
}, 1000 * 60 * 60);

// ── Static files ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

// ── Stripe (lazy init) ────────────────────────────────────────────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key === 'sk_live_YOUR_SECRET_KEY_HERE' || key.length < 20) {
    throw new Error('STRIPE_SECRET_KEY environment variable is missing or invalid. Set it in Railway.');
  }
  return require('stripe')(key);
}

// ── POST /api/create-payment-intent ─────────────────────────────────── ──
app.post('/api/create-payment-intent', rateLimit, async (req, res) => {
  try {
    const stripe = getStripe();
    const { product, username, price } = req.body;
    if (!product || !price || typeof price !== 'number' || price <= 0 || price > 10000)
      return res.status(400).json({ error: 'Invalid product or price.' });

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(price * 100),
      currency: 'usd',
      description: `BrainrotShop — ${product}`,
      metadata: { product, username: username || '(pending)', source: 'BrainrotShop' },
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: intent.client_secret, intentId: intent.id });
  } catch (err) {
    console.error('[create-payment-intent]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/update-intent-username ─────────────────────────────────────
app.post('/api/update-intent-username', async (req, res) => {
  try {
    const stripe = getStripe();
    const { intentId, username, email } = req.body;
    if (!intentId || !username) return res.json({ ok: false });
    const meta = { username };
    if (email) meta.email = email;
    await stripe.paymentIntents.update(intentId, { metadata: meta });
    res.json({ ok: true });
  } catch (err) {
    console.error('[update-intent-username]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe-webhook ──────────────────────────────────────────────
app.post(
  '/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    try {
      const stripe = getStripe();
      const sig = req.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;

      // ⚠️ Enforce webhook secret — reject unverified events
      if (!secret) {
        console.warn('[webhook] STRIPE_WEBHOOK_SECRET is not set — rejecting unverified webhook.');
        return res.status(400).send('Webhook secret not configured.');
      }

      const event = stripe.webhooks.constructEvent(req.body, sig, secret);
      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        console.log(
          `✅ Payment | $${(pi.amount / 100).toFixed(2)} | ${pi.metadata.product} | ${pi.metadata.username}`
        );
      }
      res.json({ received: true });
    } catch (err) {
      console.error('[webhook]', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BrainrotShop running on port ${PORT}`);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key === 'sk_live_YOUR_SECRET_KEY_HERE') {
    console.warn('⚠️  STRIPE_SECRET_KEY is not set — payments WILL fail! Set it in Railway Variables.');
  } else {
    console.log('✅ Stripe key loaded');
  }
  const wsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!wsec) {
    console.warn('⚠️  STRIPE_WEBHOOK_SECRET is not set — webhooks will be rejected.');
  } else {
    console.log('✅ Stripe webhook secret loaded');
  }
});
