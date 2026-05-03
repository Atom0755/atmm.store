const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PLANS = {
  basic_monthly:    { amount:  1000, interval: 'month', members: 1, label: 'Basic Monthly'    },
  basic_annual:     { amount:  9900, interval: 'year',  members: 1, label: 'Basic Annual'     },
  standard_monthly: { amount:  1300, interval: 'month', members: 2, label: 'Standard Monthly' },
  standard_annual:  { amount: 12900, interval: 'year',  members: 2, label: 'Standard Annual'  },
  premium_monthly:  { amount:  1800, interval: 'month', members: 3, label: 'Premium Monthly'  },
  premium_annual:   { amount: 16800, interval: 'year',  members: 3, label: 'Premium Annual'   },
};

async function getOrCreatePrice(planKey) {
  const plan = PLANS[planKey];
  const existing = await stripe.prices.list({ lookup_keys: [`atmm_${planKey}`], limit: 1 });
  if (existing.data.length) return existing.data[0].id;

  const product = await stripe.products.create({ name: `ATMM Store — ${plan.label}` });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: plan.amount,
    currency: 'usd',
    recurring: { interval: plan.interval },
    lookup_key: `atmm_${planKey}`,
  });
  return price.id;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { planKey, warehouseId } = req.body || {};
  if (!planKey || !PLANS[planKey]) return res.status(400).json({ error: 'Invalid plan' });

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member || member.role !== 'boss') return res.status(403).json({ error: 'Only boss can subscribe' });

  const { data: sub } = await sb.from('subscriptions')
    .select('stripe_customer_id').eq('warehouse_id', warehouseId).single();

  let customerId = sub?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { warehouse_id: warehouseId, user_id: user.id },
    });
    customerId = customer.id;
    await sb.from('subscriptions').update({ stripe_customer_id: customerId })
      .eq('warehouse_id', warehouseId);
  }

  const priceId = await getOrCreatePrice(planKey);
  const origin = req.headers.origin || 'https://atmm.store';

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { trial_end: 'now' }, // end any trial immediately, bill now
    success_url: `${origin}/?checkout=success`,
    cancel_url:  `${origin}/?checkout=canceled`,
    metadata: { warehouse_id: warehouseId, plan_key: planKey },
  });

  res.json({ url: session.url });
};
