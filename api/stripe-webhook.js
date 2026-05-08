const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'Missing STRIPE_WEBHOOK_SECRET' });

  let event;
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    // Vercel provides raw body via req.body when content-type is application/json and no body parser
    const rawBody = JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.metadata?.type === 'wallet_topup') {
      const warehouseId = session.metadata.warehouse_id;
      const topupCents  = parseInt(session.metadata.topup_cents, 10);
      if (warehouseId && topupCents > 0) {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { data: wallet } = await sb.from('wallets')
          .select('balance_cents').eq('warehouse_id', warehouseId).single();
        const current = wallet?.balance_cents ?? 0;
        await sb.from('wallets').upsert({
          warehouse_id: warehouseId,
          balance_cents: current + topupCents,
          updated_at: new Date().toISOString(),
        });
        await sb.from('wallet_transactions').insert({
          warehouse_id: warehouseId,
          type: 'topup',
          amount_cents: topupCents,
          description: `钱包充值 $${(topupCents / 100).toFixed(2)}`,
          stripe_payment_intent_id: session.payment_intent,
        });
      }
    }
  }

  res.json({ received: true });
};
