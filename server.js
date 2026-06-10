const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());

// ── WWW → non-www redirect (301) — must be before routes ───────────────────
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (host.startsWith('www.')) {
    return res.redirect(301, 'https://bloxcartel.com' + req.originalUrl);
  }
  next();
});

// ── Body size limit ────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));

// ── Rate limiter ───────────────────────────────────────────────────────────
const _rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
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

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of _rateLimitMap.entries()) {
    const fresh = timestamps.filter(t => now - t < 60 * 1000);
    if (fresh.length === 0) _rateLimitMap.delete(ip);
    else _rateLimitMap.set(ip, fresh);
  }
}, 5 * 60 * 1000);

// ── Discord webhook ────────────────────────────────────────────────────────
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1479014960775565383/K8HIiuRKKaSz4rt9My2O8VvoOKxvQqxE8XUd5SRQq2Wj3RKVjcBgOpx7fckUpZfaVvWT';

async function sendDiscord(payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
      const body = await res.text();
      console.warn(`[discord] attempt ${attempt} failed: HTTP ${res.status} — ${body}`);
      if (res.status === 429) {
        const retry_after = parseInt(res.headers.get('retry-after') || '2') * 1000 + 200;
        await new Promise(r => setTimeout(r, retry_after));
      }
    } catch (err) {
      console.error(`[discord] attempt ${attempt} error: ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  console.error('[discord] all retries exhausted — webhook did not deliver.');
  return false;
}

const clicks = {};
let direct = 0;
let totalVisits = 0;
let pageViews = 0;

// ── File helpers ───────────────────────────────────────────────────────────
function sendFile(res, filename) {
  const pub = path.join(__dirname, 'public', filename);
  const root = path.join(__dirname, filename);
  if (fs.existsSync(pub)) return res.sendFile(pub);
  if (fs.existsSync(root)) return res.sendFile(root);
  res.status(404).send(`${filename} not found`);
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  direct++;
  totalVisits++;
  sendFile(res, 'index.html');
});

app.get('/ref', (req, res) => {
  const creator = req.query.creator;
  if (creator) {
    clicks[creator] = (clicks[creator] || 0) + 1;
  }
  totalVisits++;
  sendFile(res, 'index.html');
});

app.get('/sailor-piece', (req, res) => {
  totalVisits++;
  sendFile(res, 'sailor-piece.html');
});

app.get('/aotr', (req, res) => {
  totalVisits++;
  sendFile(res, 'aotr.html');
});

// ── Blog ───────────────────────────────────────────────────────────────────
app.get('/blog', (req, res) => {
  totalVisits++;
  pageViews++;
  sendFile(res, 'pages/aotr-blog.html');
});

app.get('/checkout', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  sendFile(res, 'checkout.html');
});

// ── Sitemap ────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  sendFile(res, 'sitemap.xml');
});

// ── robots.txt ─────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('User-agent: *\nAllow: /\nSitemap: https://bloxcartel.com/sitemap.xml');
});

// (www redirect moved above routes)

// ── /pages/* routes ────────────────────────────────────────────────────────
app.get('/pages/faq', (req, res) => {
  totalVisits++;
  pageViews++;
  sendFile(res, 'pages/faq.html');
});

app.get('/pages/terms', (req, res) => {
  sendFile(res, 'pages/terms.html');
});

app.get('/pages/privacy', (req, res) => {
  sendFile(res, 'pages/privacy.html');
});

app.get('/pages/refund-policy', (req, res) => {
  sendFile(res, 'pages/refund-policy.html');
});

app.get('/pages/order-status', (req, res) => {
  totalVisits++;
  pageViews++;
  sendFile(res, 'pages/order-status.html');
});

// ── Traffic report every 60 minutes ───────────────────────────────────────
setInterval(async () => {
  const refEntries = Object.entries(clicks);
  const refLines = refEntries.length > 0
    ? refEntries
        .sort((a, b) => b[1] - a[1])
        .map(([creator, count]) => `🔗 **${creator}** — ${count} visits`)
        .join('\n')
    : '_(no referral visits yet)_';

  const report = [
    `📊 **BloxCartel Traffic Report**`,
    ``,
    `🌐 **Direct visits** — ${direct}`,
    `👥 **Total visits** — ${totalVisits}`,
    `📄 **Page views (FAQ/legal)** — ${pageViews}`,
    ``,
    `**Referral Breakdown:**`,
    refLines
  ].join('\n');

  await sendDiscord({ content: report });
  console.log('📊 Traffic report sent to Discord');
}, 1000 * 60 * 60);

// ── Static files ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

// ── 404 catch-all ──────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Page Not Found — BloxCartel</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&family=Fredoka+One&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Outfit',sans-serif;background:#08070f;color:#f0eaff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 20px}
    h1{font-family:'Fredoka One',cursive;font-size:clamp(2rem,5vw,3.5rem);margin-bottom:16px;letter-spacing:.01em}
    h1 span{background:linear-gradient(135deg,#7c3aed,#9d5cf7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    p{color:#b8aed4;font-size:1rem;margin-bottom:28px;max-width:420px;line-height:1.6}
    a{display:inline-flex;align-items:center;gap:8px;background:#7c3aed;color:#fff;padding:13px 28px;border-radius:12px;font-weight:800;font-size:.95rem;text-decoration:none;border:2px solid #6d28d9;box-shadow:4px 4px 0 #6d28d9;transition:all .18s}
    a:hover{transform:translate(-1px,-2px);box-shadow:5px 5px 0 #6d28d9}
  </style>
</head>
<body>
  <h1><span>404</span> — Page Not Found</h1>
  <p>Oops! The page you're looking for doesn't exist or has been moved.</p>
  <a href="/">← Back to BloxCartel</a>
</body>
</html>`);
});

// ── Stripe (lazy init) ─────────────────────────────────────────────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key === 'sk_live_YOUR_SECRET_KEY_HERE' || key.length < 20) {
    throw new Error('STRIPE_SECRET_KEY environment variable is missing or invalid. Set it in Railway.');
  }
  return require('stripe')(key);
}

// ── POST /api/create-payment-intent ───────────────────────────────────────
app.post('/api/create-payment-intent', rateLimit, async (req, res) => {
  try {
    const stripe = getStripe();
    const { product, username, price } = req.body;
    if (!product || !price || typeof price !== 'number' || price <= 0 || price > 10000)
      return res.status(400).json({ error: 'Invalid product or price.' });

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(price * 100),
      currency: 'usd',
      description: `BloxCartel — ${product}`,
      metadata: { product, username: username || '(pending)', source: 'BloxCartel' },
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

// ── POST /api/stripe-webhook ───────────────────────────────────────────────
app.post(
  '/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const stripe = getStripe();
      const sig = req.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!secret) {
        console.warn('[webhook] STRIPE_WEBHOOK_SECRET not set — rejecting.');
        return res.status(400).send('Webhook secret not configured.');
      }

      const event = stripe.webhooks.constructEvent(req.body, sig, secret);

      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        const amount = (pi.amount / 100).toFixed(2);
        const product = pi.metadata.product || 'Unknown';
        const username = pi.metadata.username || '(unknown)';
        const email = pi.metadata.email || '(no email)';

        console.log(`✅ Payment | $${amount} | ${product} | ${username}`);

        await sendDiscord({
          embeds: [{
            title: '💸 New Sale — BloxCartel',
            color: 0x7c3aed,
            fields: [
              { name: '📦 Product', value: product, inline: true },
              { name: '💰 Amount', value: `$${amount}`, inline: true },
              { name: '👤 Username', value: username, inline: true },
              { name: '📧 Email', value: email, inline: false },
            ],
            timestamp: new Date().toISOString(),
          }]
        });
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
  console.log(`🚀 BloxCartel running on port ${PORT}`);

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key === 'sk_live_YOUR_SECRET_KEY_HERE') {
    console.warn('⚠️  STRIPE_SECRET_KEY is not set — payments WILL fail!');
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
