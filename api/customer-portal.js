const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { warehouseId } = req.body || {};
  const { data: sub } = await sb.from('subscriptions')
    .select('stripe_customer_id').eq('warehouse_id', warehouseId).single();

  if (!sub?.stripe_customer_id)
    return res.status(404).json({ error: 'No Stripe customer found — subscribe first' });

  const origin = req.headers.origin || 'https://atmm.store';
  const session = await stripe.billingPortal.sessions.create({
    customer:   sub.stripe_customer_id,
    return_url: origin + '/',
  });

  res.json({ url: session.url });
};
