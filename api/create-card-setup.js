const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

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

  const { warehouseId } = req.body || {};
  if (!warehouseId) return res.status(400).json({ error: 'Missing warehouseId' });

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member || member.role !== 'boss')
    return res.status(403).json({ error: 'Only boss can manage payment methods' });

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
  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'setup',
      payment_method_types: ['card'],
      success_url: `${origin}/?card=saved`,
      cancel_url:  `${origin}/?card=canceled`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('create-card-setup error:', e);
    res.status(500).json({ error: e.message });
  }
};
