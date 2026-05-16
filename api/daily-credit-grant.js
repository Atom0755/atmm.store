const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { warehouseId } = req.body || {};
  if (!warehouseId) return res.status(400).json({ error: 'Missing warehouseId' });

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member) return res.status(403).json({ error: 'Forbidden' });

  try {
    // Server-side idempotency: check for today's daily_grant via JS client (no URL encoding issues)
    const today = new Date().toISOString().split('T')[0];
    const { data: existing } = await sb.from('warehouse_credit_transactions')
      .select('id')
      .eq('warehouse_id', warehouseId)
      .eq('type', 'daily_grant')
      .gte('created_at', today + 'T00:00:00Z')
      .limit(1)
      .maybeSingle();

    if (existing) {
      return res.json({ granted: false, reason: 'already_granted_today' });
    }

    // Get current credits balance
    const { data: cr } = await sb.from('credits')
      .select('id, balance').eq('warehouse_id', warehouseId).maybeSingle();
    const current = cr?.balance ?? 0;

    if (cr?.id) {
      await sb.from('credits')
        .update({ balance: current + 1, updated_at: new Date().toISOString() })
        .eq('id', cr.id);
    } else {
      await sb.from('credits')
        .insert({ warehouse_id: warehouseId, balance: 1, updated_at: new Date().toISOString() });
    }

    await sb.from('warehouse_credit_transactions').insert({
      warehouse_id: warehouseId,
      type: 'daily_grant',
      amount: 1,
      description: 'daily_grant',
    });

    return res.json({ granted: true, credits: current + 1 });
  } catch (err) {
    console.error('daily-credit-grant error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
