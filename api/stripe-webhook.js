const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

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

  let event;
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
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
