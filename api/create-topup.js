const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const TOPUP_OPTIONS = {
  20:  2000,
  50:  5000,
  100: 10000,
  200: 20000,
};

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY)
    return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { warehouseId, amountUsd } = req.body || {};
  if (!warehouseId || !amountUsd) return res.status(400).json({ error: 'Missing fields' });

  const amountCents = TOPUP_OPTIONS[amountUsd];
  if (!amountCents) return res.status(400).json({ error: 'Invalid amount. Choose: 20, 50, 100, 200' });

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member || member.role !== 'boss')
    return res.status(403).json({ error: 'Only boss can top up wallet' });

  const { data: sub } = await sb.from('subscriptions')
    .select('stripe_customer_id').eq('warehouse_id', warehouseId).single();

  let customerId = sub?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { warehouse_id: warehouseId, user_id: user.id },
    });
    customerId = customer.id;
    await sb.from('subscriptions').update({ stripe_customer_id: customerId }).eq('warehouse_id', warehouseId);
  }

  const origin = req.headers.origin || 'https://atmm.store';
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `ATMM 钱包充值 $${amountUsd}` },
        unit_amount: amountCents,
      },
      quantity: 1,
    }],
    success_url: `${origin}/?topup=success`,
    cancel_url:  `${origin}/?topup=canceled`,
    metadata: { warehouse_id: warehouseId, topup_cents: amountCents, type: 'wallet_topup' },
  });

  res.json({ url: session.url });
};
