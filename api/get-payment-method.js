const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY)
    return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const warehouseId = req.query.warehouse_id;
  if (!warehouseId) return res.json({ card: null });

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member) return res.status(403).json({ error: 'Forbidden' });

  const { data: sub } = await sb.from('subscriptions')
    .select('stripe_customer_id').eq('warehouse_id', warehouseId).single();
  if (!sub?.stripe_customer_id) return res.json({ card: null });

  try {
    const customer = await stripe.customers.retrieve(sub.stripe_customer_id, {
      expand: ['invoice_settings.default_payment_method']
    });

    let pm = customer.invoice_settings?.default_payment_method;

    // If no default set, try listing payment methods (e.g. after Setup Session)
    if (!pm || typeof pm === 'string') {
      const pmList = await stripe.paymentMethods.list({
        customer: sub.stripe_customer_id,
        type: 'card',
        limit: 1,
      });
      if (pmList.data.length > 0) {
        pm = pmList.data[0];
        // Set it as the default for future charges
        await stripe.customers.update(sub.stripe_customer_id, {
          invoice_settings: { default_payment_method: pm.id },
        });
      }
    }

    if (!pm || typeof pm === 'string') return res.json({ card: null });

    res.json({
      card: {
        brand: pm.card?.brand || 'card',
        last4: pm.card?.last4 || '••••',
        exp_month: pm.card?.exp_month,
        exp_year: pm.card?.exp_year,
      }
    });
  } catch (e) {
    console.error('get-payment-method error:', e);
    res.json({ card: null });
  }
};
