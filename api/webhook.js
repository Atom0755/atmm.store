const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Vercel: disable body parser so we can verify Stripe signature on raw body
module.exports.config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const PLAN_FROM_KEY = key => {
  if (!key) return 'basic';
  if (key.includes('premium'))  return 'premium';
  if (key.includes('standard')) return 'standard';
  return 'basic';
};
const MEMBERS = { basic: 1, standard: 2, premium: 3 };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const rawBody = await readRawBody(req);
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const obj = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const warehouseId = obj.metadata?.warehouse_id;
    const planKey     = obj.metadata?.plan_key;
    if (!warehouseId) return res.status(200).end();

    const plan    = PLAN_FROM_KEY(planKey);
    const isAnnual = (planKey || '').includes('annual');

    // Fetch subscription period end from Stripe
    let periodEnd = null;
    if (obj.subscription) {
      const stripeSub = await stripe.subscriptions.retrieve(obj.subscription);
      periodEnd = new Date(stripeSub.current_period_end * 1000).toISOString();
    }

    await sb.from('subscriptions').update({
      stripe_customer_id:     obj.customer,
      stripe_subscription_id: obj.subscription,
      plan,
      billing_cycle:       isAnnual ? 'annual' : 'monthly',
      status:              'active',
      max_members:         MEMBERS[plan] || 1,
      current_period_end:  periodEnd,
      updated_at:          new Date().toISOString(),
    }).eq('warehouse_id', warehouseId);
  }

  if (event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted') {
    const { data: sub } = await sb.from('subscriptions')
      .select('warehouse_id').eq('stripe_subscription_id', obj.id).single();
    if (sub) {
      const newStatus = obj.status === 'active' ? 'active'
        : obj.status === 'canceled' ? 'canceled' : 'past_due';
      await sb.from('subscriptions').update({
        status:             newStatus,
        current_period_end: new Date(obj.current_period_end * 1000).toISOString(),
        updated_at:         new Date().toISOString(),
      }).eq('warehouse_id', sub.warehouse_id);
    }
  }

  res.status(200).json({ received: true });
};
