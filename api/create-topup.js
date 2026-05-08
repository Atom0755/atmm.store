const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const MIN_TOPUP_USD = 1;
const MAX_TOPUP_USD = 9999;

async function creditWallet(sb, warehouseId, topupCents, amountUsd, paymentIntentId) {
  const { data: existing } = await sb.from('warehouse_transactions')
    .select('id').eq('stripe_payment_intent_id', paymentIntentId).maybeSingle();
  if (existing) return; // already credited (idempotency)

  const { data: walletRow } = await sb.from('wallets')
    .select('id, balance_cents').eq('warehouse_id', warehouseId).maybeSingle();
  const current = walletRow?.balance_cents ?? 0;
  if (walletRow?.id) {
    await sb.from('wallets')
      .update({ balance_cents: current + topupCents, updated_at: new Date().toISOString() })
      .eq('id', walletRow.id);
  } else {
    await sb.from('wallets')
      .insert({ warehouse_id: warehouseId, balance_cents: current + topupCents, updated_at: new Date().toISOString() });
  }
  await sb.from('warehouse_transactions').insert({
    warehouse_id: warehouseId,
    type: 'topup',
    amount_cents: topupCents,
    description: `钱包充值 $${amountUsd}`,
    stripe_payment_intent_id: paymentIntentId,
  });
}

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

  const amountNum = Number(amountUsd);
  if (!amountNum || amountNum < MIN_TOPUP_USD || amountNum > MAX_TOPUP_USD)
    return res.status(400).json({ error: `充值金额须在 $${MIN_TOPUP_USD}–$${MAX_TOPUP_USD} 之间` });
  const amountCents = Math.round(amountNum * 100);

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member || member.role !== 'boss')
    return res.status(403).json({ error: 'Only boss can top up wallet' });

  const { data: sub } = await sb.from('subscriptions')
    .select('stripe_customer_id').eq('warehouse_id', warehouseId).single();

  let customerId = sub?.stripe_customer_id;
  if (customerId) {
    try { await stripe.customers.retrieve(customerId); }
    catch { customerId = null; }
  }
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { warehouse_id: warehouseId, user_id: user.id },
    });
    customerId = customer.id;
    await sb.from('subscriptions').update({ stripe_customer_id: customerId }).eq('warehouse_id', warehouseId);
  }

  // Try direct charge with saved card (bypasses Stripe Link / Checkout)
  let defaultPmId = null;
  try {
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    });
    const pm = customer.invoice_settings?.default_payment_method;
    if (pm && typeof pm !== 'string') defaultPmId = pm.id;
    else if (typeof pm === 'string' && pm) defaultPmId = pm;

    if (!defaultPmId) {
      const pmList = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      if (pmList.data.length > 0) defaultPmId = pmList.data[0].id;
    }
  } catch (e) {
    console.error('error fetching default PM:', e);
  }

  const origin = req.headers.origin || 'https://atmm.store';

  if (defaultPmId) {
    try {
      const pi = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        customer: customerId,
        payment_method: defaultPmId,
        off_session: true,
        confirm: true,
        description: `ATMM 钱包充值 $${amountUsd}`,
        metadata: { warehouse_id: warehouseId, topup_cents: amountCents.toString(), type: 'wallet_topup' },
        return_url: `${origin}/?topup=success`,
      });

      if (pi.status === 'succeeded') {
        await creditWallet(sb, warehouseId, amountCents, amountUsd, pi.id);
        return res.json({ success: true, message: `充值成功！已增加 $${amountUsd}` });
      }
      if (pi.status === 'requires_action') {
        const actionUrl = pi.next_action?.redirect_to_url?.url;
        if (actionUrl) return res.json({ url: actionUrl, payment_intent_id: pi.id });
      }
    } catch (e) {
      // Card declined or other charge error — fall through to Checkout
      console.error('direct charge failed:', e.message);
      if (e.type === 'StripeCardError') {
        return res.status(400).json({ error: `卡片被拒绝: ${e.message}` });
      }
    }
  }

  // Fallback: Checkout session (no saved card, or 3DS not redirectable)
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
    metadata: { warehouse_id: warehouseId, topup_cents: amountCents.toString(), type: 'wallet_topup' },
  });

  res.json({ url: session.url });
};
