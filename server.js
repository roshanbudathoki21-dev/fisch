const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── Serve static files — works whether index.html is in /public or root ───
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

app.get('/', (_req, res) => {
  const pub = path.join(__dirname, 'public', 'index.html');
  const root = path.join(__dirname, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(pub))  return res.sendFile(pub);
  if (fs.existsSync(root)) return res.sendFile(root);
  res.status(404).send('index.html not found');
});

// ── Stripe (lazy init so missing key doesn't crash on startup) ────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key === 'sk_live_YOUR_SECRET_KEY_HERE') {
    throw new Error('STRIPE_SECRET_KEY environment variable is not set.');
  }
  return require('stripe')(key);
}

// ── POST /api/create-payment-intent ───────────────────────────────────────
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const stripe = getStripe();
    const { product, username, price } = req.body;
    if (!product || !price || typeof price !== 'number' || price <= 0)
      return res.status(400).json({ error: 'Invalid product or price.' });

    const intent = await stripe.paymentIntents.create({
      amount:      Math.round(price * 100),
      currency:    'usd',
      description: `BrainrotShop — ${product}`,
      metadata:    { product, username: username || '(pending)', source: 'BrainrotShop' },
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: intent.client_secret, intentId: intent.id });
  } catch (err) {
    console.error('[create-payment-intent]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/update-intent-username ──────────────────────────────────────
app.post('/api/update-intent-username', async (req, res) => {
  try {
    const stripe = getStripe();
    const { intentId, username } = req.body;
    if (!intentId || !username) return res.json({ ok: false });
    await stripe.paymentIntents.update(intentId, { metadata: { username } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[update-intent-username]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe-webhook ───────────────────────────────────────────────
app.post('/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    try {
      const stripe = getStripe();
      const sig    = req.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) return res.json({ received: true });

      const event = stripe.webhooks.constructEvent(req.body, sig, secret);

      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        console.log(`✅ Payment | $${(pi.amount/100).toFixed(2)} | ${pi.metadata.product} | ${pi.metadata.username}`);
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
    console.warn('⚠️  STRIPE_SECRET_KEY is not set — payments will fail!');
  } else {
    console.log('✅ Stripe key loaded');
  }
});
