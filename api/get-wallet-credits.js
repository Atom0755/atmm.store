const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const warehouseId = req.query.warehouse_id;
  if (!warehouseId) return res.status(400).json({ error: 'Missing warehouse_id' });

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member) return res.status(403).json({ error: 'Forbidden' });

  const [walletRes, creditsRes, walletTxRes, creditTxRes] = await Promise.all([
    sb.from('wallets').select('balance_cents').eq('warehouse_id', warehouseId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('credits').select('balance').eq('warehouse_id', warehouseId).maybeSingle(),
    sb.from('warehouse_transactions').select('type,amount_cents,description,created_at')
      .eq('warehouse_id', warehouseId).order('created_at', { ascending: false }).limit(10),
    sb.from('warehouse_credit_transactions').select('type,amount,description,created_at')
      .eq('warehouse_id', warehouseId).order('created_at', { ascending: false }).limit(10),
  ]);

  res.json({
    wallet_cents: walletRes.data?.balance_cents ?? 0,
    credits: creditsRes.data?.balance ?? 0,
    wallet_transactions: walletTxRes.data || [],
    credit_transactions: creditTxRes.data || [],
  });
};
