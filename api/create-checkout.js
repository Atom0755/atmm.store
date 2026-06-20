const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// 套餐目录（amount 单位=美分）。modules/members 由 webhook 付款后回写到订阅。
// ⚠️ webhook 里有同一份配置，改价请两处同步。
const PLANS = {
  // 一件代发（按人数）
  basic_monthly:    { amount:   1900, interval: 'month', trialDays:  7, members: 1, modules:['yijian'], label: 'Basic Monthly'    },
  basic_annual:     { amount:  36500, interval: 'year',  trialDays: 30, members: 1, modules:['yijian'], label: 'Basic Annual'     },
  standard_monthly: { amount:   6800, interval: 'month', trialDays:  7, members: 2, modules:['yijian'], label: 'Standard Monthly' },
  standard_annual:  { amount:  88800, interval: 'year',  trialDays: 30, members: 2, modules:['yijian'], label: 'Standard Annual'  },
  premium_monthly:  { amount:  18800, interval: 'month', trialDays:  7, members: 3, modules:['yijian'], label: 'Premium Monthly'  },
  premium_annual:   { amount: 188800, interval: 'year',  trialDays: 30, members: 3, modules:['yijian'], label: 'Premium Annual'   },
  // 转运+快拆（全业务·1-2人）
  ztk_monthly:      { amount:  28800, interval: 'month', trialDays:  0, members: 2,  modules:['yijian','zhuanyun'], label: '转运快拆 1-2人 月付' },
  ztk_annual:       { amount: 345600, interval: 'year',  trialDays:  0, members: 2,  modules:['yijian','zhuanyun'], label: '转运快拆 1-2人 年付' },
  // 全业务套餐（一件代发+转运+快拆，按人数）
  full3_monthly:    { amount:  45600, interval: 'month', trialDays:  0, members: 3,  modules:['yijian','zhuanyun'], label: '全业务 3人 月付' },
  full3_annual:     { amount: 500800, interval: 'year',  trialDays:  0, members: 3,  modules:['yijian','zhuanyun'], label: '全业务 3人 年付' },
  full4_monthly:    { amount:  56800, interval: 'month', trialDays:  0, members: 4,  modules:['yijian','zhuanyun'], label: '全业务 4人 月付' },
  full4_annual:     { amount: 568800, interval: 'year',  trialDays:  0, members: 4,  modules:['yijian','zhuanyun'], label: '全业务 4人 年付' },
  full5_monthly:    { amount:  58800, interval: 'month', trialDays:  0, members: 5,  modules:['yijian','zhuanyun'], label: '全业务 5人 月付' },
  full5_annual:     { amount: 588800, interval: 'year',  trialDays:  0, members: 5,  modules:['yijian','zhuanyun'], label: '全业务 5人 年付' },
  full13_monthly:   { amount:  68800, interval: 'month', trialDays:  0, members: 13, modules:['yijian','zhuanyun'], label: '全业务 6-13人 月付' },
  full13_annual:    { amount: 800800, interval: 'year',  trialDays:  0, members: 13, modules:['yijian','zhuanyun'], label: '全业务 6-13人 年付' },
};

module.exports = async function handler(req, res) {
  // Always respond with JSON so the frontend can read the error
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Validate required env vars early so the error is clear
  if (!process.env.STRIPE_SECRET_KEY)
    return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY on server' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ error: 'Missing Supabase env vars on server' });

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { planKey, warehouseId } = req.body || {};
    if (!planKey || !PLANS[planKey]) return res.status(400).json({ error: 'Invalid plan: ' + planKey });

    const { data: member } = await sb.from('warehouse_members')
      .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
    if (!member || member.role !== 'boss')
      return res.status(403).json({ error: 'Only boss can subscribe' });

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
      await sb.from('subscriptions').update({ stripe_customer_id: customerId })
        .eq('warehouse_id', warehouseId);
    }

    // Find or create a Stripe price for this plan
    const plan = PLANS[planKey];
    const existing = await stripe.prices.list({ lookup_keys: [`atmm2_${planKey}`], limit: 1 });
    let priceId;
    if (existing.data.length) {
      priceId = existing.data[0].id;
    } else {
      const product = await stripe.products.create({ name: `ATMM Store — ${plan.label}` });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.amount,
        currency: 'usd',
        recurring: { interval: plan.interval },
        lookup_key: `atmm2_${planKey}`,
      });
      priceId = price.id;
    }

    const origin = req.headers.origin || 'https://atmm.store';
    const subMeta = { warehouse_id: warehouseId, plan_key: planKey };
    const subscription_data = plan.trialDays > 0
      ? { trial_period_days: plan.trialDays, metadata: subMeta }
      : { metadata: subMeta };
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data,
      success_url: `${origin}/?checkout=success`,
      cancel_url:  `${origin}/?checkout=canceled`,
      metadata: { warehouse_id: warehouseId, plan_key: planKey },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('create-checkout error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
};
