const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  console.log('[gwc] START url=', req.url, 'supabase=', process.env.SUPABASE_URL?.slice(0, 40));

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) { console.log('[gwc] no token'); return res.status(401).json({ error: 'Unauthorized' }); }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) { console.log('[gwc] auth fail', authErr?.message); return res.status(401).json({ error: 'Unauthorized' }); }

  const warehouseId = req.query.warehouse_id;
  if (!warehouseId) return res.status(400).json({ error: 'Missing warehouse_id' });

  console.log('[gwc] user=', user.id, 'warehouseId=', warehouseId);

  const { data: member, error: memberErr } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  console.log('[gwc] member=', JSON.stringify(member), 'memberErr=', memberErr?.message);
  if (!member) return res.status(403).json({ error: 'Forbidden' });

  // Wallet balance
  const { data: walletRow, error: walletErr } = await sb
    .from('wallets')
    .select('balance_cents')
    .eq('warehouse_id', warehouseId)
    .maybeSingle();

  if (walletErr) console.error('[get-wallet-credits] wallets error:', JSON.stringify(walletErr));
  console.log('[get-wallet-credits] warehouseId:', warehouseId, 'walletRow:', JSON.stringify(walletRow), 'SUPABASE_URL:', process.env.SUPABASE_URL?.slice(0, 40));

  // Credits balance
  const { data: creditsRow, error: creditsErr } = await sb
    .from('credits')
    .select('balance')
    .eq('warehouse_id', warehouseId)
    .maybeSingle();

  if (creditsErr) console.error('[get-wallet-credits] credits error:', JSON.stringify(creditsErr));

  // Transaction history
  const { data: walletTxs } = await sb
    .from('warehouse_transactions')
    .select('type,amount_cents,description,created_at')
    .eq('warehouse_id', warehouseId)
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: creditTxs } = await sb
    .from('warehouse_credit_transactions')
    .select('type,amount,description,created_at')
    .eq('warehouse_id', warehouseId)
    .order('created_at', { ascending: false })
    .limit(10);

  res.json({
    wallet_cents: walletRow?.balance_cents ?? 0,
    credits: creditsRow?.balance ?? 0,
    wallet_transactions: walletTxs || [],
    credit_transactions: creditTxs || [],
  });
};
