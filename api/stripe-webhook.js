const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// 套餐 → 成员数 / 业务模块（与 create-checkout.js 同步）。付款后据此回写订阅。
const PLAN_CFG = {
  basic:    { members: 1,  modules: ['yijian'] },
  standard: { members: 2,  modules: ['yijian'] },
  premium:  { members: 3,  modules: ['yijian'] },
  ztk:      { members: 2,  modules: ['yijian','zhuanyun'] },
  full3:    { members: 3,  modules: ['yijian','zhuanyun'] },
  full4:    { members: 4,  modules: ['yijian','zhuanyun'] },
  full5:    { members: 5,  modules: ['yijian','zhuanyun'] },
  full13:   { members: 13, modules: ['yijian','zhuanyun'] },
};

async function creditWallet(sb, warehouseId, topupCents, paymentIntentId) {
  const { data: existing } = await sb.from('warehouse_transactions')
    .select('id').eq('stripe_payment_intent_id', paymentIntentId).maybeSingle();
  if (existing) return; // idempotency — already credited

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
    description: `钱包充值 $${(topupCents / 100).toFixed(2)}`,
    stripe_payment_intent_id: paymentIntentId,
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'Missing STRIPE_WEBHOOK_SECRET' });

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    const rawBody = JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Checkout session completed (fallback Checkout flow for topup)
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.metadata?.type === 'wallet_topup') {
      const warehouseId = session.metadata.warehouse_id;
      const topupCents  = parseInt(session.metadata.topup_cents, 10);
      if (warehouseId && topupCents > 0) {
        await creditWallet(sb, warehouseId, topupCents, session.payment_intent);
      }
    }
    // 订阅付款成功 → 回写套餐/人数/业务模块（gating 据此解锁）
    if (session.mode === 'subscription' && session.metadata?.plan_key && session.metadata?.warehouse_id) {
      const pk = session.metadata.plan_key;
      const planVal = pk.replace(/_(monthly|annual)$/, '');
      const cycle = pk.endsWith('_annual') ? 'annual' : 'monthly';
      const cfg = PLAN_CFG[planVal];
      if (cfg) {
        let periodEnd = null;
        try {
          if (session.subscription) {
            const ss = await stripe.subscriptions.retrieve(session.subscription);
            if (ss.current_period_end) periodEnd = new Date(ss.current_period_end * 1000).toISOString();
          }
        } catch (e) { /* 取不到周期结束时间不阻断 */ }
        await sb.from('subscriptions').update({
          plan: planVal,
          billing_cycle: cycle,
          status: 'active',
          max_members: cfg.members,
          modules: cfg.modules,
          stripe_subscription_id: session.subscription || null,
          current_period_end: periodEnd,
          updated_at: new Date().toISOString(),
        }).eq('warehouse_id', session.metadata.warehouse_id);
      }
    }
  }

  // 订阅被取消 → 降级回「一件代发」最小权限
  if (event.type === 'customer.subscription.deleted') {
    const subObj = event.data.object;
    const { data: row } = await sb.from('subscriptions')
      .select('warehouse_id').eq('stripe_subscription_id', subObj.id).maybeSingle();
    if (row?.warehouse_id) {
      await sb.from('subscriptions').update({
        status: 'canceled', modules: ['yijian'], updated_at: new Date().toISOString(),
      }).eq('warehouse_id', row.warehouse_id);
    }
  }

  // PaymentIntent succeeded (direct charge flow, or after 3DS redirect)
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    if (pi.metadata?.type === 'wallet_topup') {
      const warehouseId = pi.metadata.warehouse_id;
      const topupCents  = parseInt(pi.metadata.topup_cents, 10);
      if (warehouseId && topupCents > 0) {
        await creditWallet(sb, warehouseId, topupCents, pi.id);
      }
    }
  }

  // Subscription first payment — mark referral as subscribed
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    if (invoice.billing_reason === 'subscription_create' && invoice.customer) {
      const { data: sub } = await sb.from('subscriptions')
        .select('warehouse_id').eq('stripe_customer_id', invoice.customer).maybeSingle();
      if (sub?.warehouse_id) {
        await sb.from('referrals')
          .update({ status: 'subscribed', subscribed_at: new Date().toISOString() })
          .eq('referee_warehouse_id', sub.warehouse_id)
          .eq('status', 'pending');
      }
    }
  }

  res.json({ received: true });
};
