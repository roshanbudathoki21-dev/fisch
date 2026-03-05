// ─────────────────────────────────────────────
//  BrainrotShop — server.js
//  Run:  node server.js
//  Deps: npm install express stripe cors
// ─────────────────────────────────────────────
const express = require('express');
const Stripe   = require('stripe');
const cors     = require('cors');
const path     = require('path');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_live_YOUR_SECRET_KEY_HERE');

app.use(cors());
app.use(express.json());

// ── Static files (put index.html inside /public) ──────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ── POST /api/create-payment-intent ───────────────────────────────────────
// Body:    { product: string, username: string, price: number }
// Returns: { clientSecret: string, intentId: string }
app.post('/api/create-payment-intent', async (req, res) => {
  try {
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
// Body:    { intentId: string, username: string }
// Returns: { ok: true }
app.post('/api/update-intent-username', async (req, res) => {
  try {
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
// Point your Stripe dashboard webhook to: https://yourdomain.com/api/stripe-webhook
// Set env var: STRIPE_WEBHOOK_SECRET=whsec_...
app.post('/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.json({ received: true });

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error('[webhook sig error]', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      console.log(
        `✅ Payment succeeded | $${(pi.amount / 100).toFixed(2)} | ` +
        `Product: ${pi.metadata.product} | User: ${pi.metadata.username} | ID: ${pi.id}`
      );
      // TODO: trigger delivery / Discord notification here
    }

    res.json({ received: true });
  }
);

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BrainrotShop running → http://localhost:${PORT}`);
  console.log(`   Stripe key loaded: ${stripe._api ? '✅' : '⚠️  check STRIPE_SECRET_KEY'}`);
});
