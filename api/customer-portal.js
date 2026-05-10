const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { action = 'portal', warehouseId, paymentMethodId } = req.body || {};

  const { data: sub } = await sb.from('subscriptions')
    .select('stripe_customer_id').eq('warehouse_id', warehouseId).single();
  if (!sub?.stripe_customer_id)
    return res.status(404).json({ error: 'No Stripe customer found — subscribe first' });

  const customerId = sub.stripe_customer_id;

  try {
    if (action === 'list') {
      const [pmList, customer] = await Promise.all([
        stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 20 }),
        stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] }),
      ]);
      const defaultPm = customer.invoice_settings?.default_payment_method;
      const defaultPmId = typeof defaultPm === 'string' ? defaultPm : defaultPm?.id;
      return res.json({
        cards: pmList.data.map(pm => ({
          id: pm.id,
          brand: pm.card?.brand || 'card',
          last4: pm.card?.last4 || '••••',
          exp_month: pm.card?.exp_month,
          exp_year: pm.card?.exp_year,
          is_default: pm.id === defaultPmId,
        })),
      });
    }

    if (action === 'set_default') {
      if (!paymentMethodId) return res.status(400).json({ error: 'Missing paymentMethodId' });
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
      return res.json({ ok: true });
    }

    if (action === 'delete') {
      if (!paymentMethodId) return res.status(400).json({ error: 'Missing paymentMethodId' });
      const pmList = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 2 });
      if (pmList.data.length <= 1)
        return res.status(400).json({ error: '至少保留一张银行卡，不能删除最后一张' });
      await stripe.paymentMethods.detach(paymentMethodId);
      return res.json({ ok: true });
    }

    // Default: open Stripe billing portal (for subscription management)
    const origin = req.headers.origin || 'https://atmm.store';
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: origin + '/',
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('customer-portal error:', e);
    res.status(500).json({ error: e.message });
  }
};
