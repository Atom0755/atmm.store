const { createClient } = require('@supabase/supabase-js');

const CENTS_PER_CREDIT = 100;  // $1 = 12 credits  → 1 credit = $0.0833
const CREDITS_PER_DOLLAR = 12; // $10 = 120 credits

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { warehouseId, amountUsd } = req.body || {};
  if (!warehouseId || !amountUsd || amountUsd < 1)
    return res.status(400).json({ error: 'Invalid amount (min $1)' });

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member || member.role !== 'boss')
    return res.status(403).json({ error: 'Forbidden' });

  const deductCents = Math.round(amountUsd * 100);
  const earnCredits = Math.round(amountUsd * CREDITS_PER_DOLLAR);

  // Deduct from wallet
  const { data: wallet } = await sb.from('wallets')
    .select('balance_cents').eq('warehouse_id', warehouseId).single();
  if (!wallet || wallet.balance_cents < deductCents)
    return res.status(400).json({ error: '钱包余额不足' });

  await sb.from('wallets')
    .update({ balance_cents: wallet.balance_cents - deductCents, updated_at: new Date().toISOString() })
    .eq('warehouse_id', warehouseId);
  await sb.from('warehouse_transactions').insert({
    warehouse_id: warehouseId, type: 'convert_to_credits',
    amount_cents: -deductCents, description: `兑换 ${earnCredits} Credits`,
  });

  // Add to credits
  const { data: credits } = await sb.from('credits')
    .select('balance').eq('warehouse_id', warehouseId).maybeSingle();
  const currentCredits = credits?.balance ?? 0;
  const { data: credRow } = await sb.from('credits')
    .select('id').eq('warehouse_id', warehouseId).maybeSingle();
  if (credRow?.id) {
    await sb.from('credits')
      .update({ balance: currentCredits + earnCredits, updated_at: new Date().toISOString() })
      .eq('id', credRow.id);
  } else {
    await sb.from('credits')
      .insert({ warehouse_id: warehouseId, balance: currentCredits + earnCredits, updated_at: new Date().toISOString() });
  }
  await sb.from('warehouse_credit_transactions').insert({
    warehouse_id: warehouseId, type: 'convert_from_wallet',
    amount: earnCredits, description: `从钱包兑换 $${amountUsd}`,
  });

  res.json({ ok: true, wallet_cents: wallet.balance_cents - deductCents, credits: currentCredits + earnCredits });
};
