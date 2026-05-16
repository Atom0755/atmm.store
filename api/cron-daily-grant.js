const { createClient } = require('@supabase/supabase-js');

// Vercel Cron Job — runs at 00:01 UTC every day
// Grants +1 Z Credit to every warehouse that hasn't received one today.
// Secured: only callable by Vercel cron (Authorization: Bearer CRON_SECRET).

module.exports = async function handler(req, res) {
  // Verify Vercel cron secret
  const auth = req.headers.authorization || '';
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const today = new Date().toISOString().split('T')[0];
  let granted = 0, skipped = 0, errors = 0;

  try {
    // Get all warehouse IDs
    const { data: warehouses, error: whErr } = await sb.from('warehouses').select('id');
    if (whErr) throw whErr;

    for (const wh of (warehouses || [])) {
      try {
        // Check if already granted today for this warehouse
        const { data: existing } = await sb.from('warehouse_credit_transactions')
          .select('id')
          .eq('warehouse_id', wh.id)
          .eq('type', 'daily_grant')
          .gte('created_at', today + 'T00:00:00Z')
          .limit(1)
          .maybeSingle();

        if (existing) { skipped++; continue; }

        // Grant +1 credit
        const { data: cr } = await sb.from('credits')
          .select('id, balance').eq('warehouse_id', wh.id).maybeSingle();
        const current = cr?.balance ?? 0;

        if (cr?.id) {
          await sb.from('credits')
            .update({ balance: current + 1, updated_at: new Date().toISOString() })
            .eq('id', cr.id);
        } else {
          await sb.from('credits')
            .insert({ warehouse_id: wh.id, balance: 1, updated_at: new Date().toISOString() });
        }

        await sb.from('warehouse_credit_transactions').insert({
          warehouse_id: wh.id,
          type: 'daily_grant',
          amount: 1,
          description: 'daily_grant',
        });

        granted++;
      } catch (e) {
        console.error(`[cron-daily-grant] warehouse ${wh.id} error:`, e.message);
        errors++;
      }
    }

    console.log(`[cron-daily-grant] ${today} — granted:${granted} skipped:${skipped} errors:${errors}`);
    return res.json({ ok: true, date: today, granted, skipped, errors });
  } catch (err) {
    console.error('[cron-daily-grant] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
