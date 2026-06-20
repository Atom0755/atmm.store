const { createClient } = require('@supabase/supabase-js');

// 定时重置「体验账号」仓库：恢复库存快照 + 清空体验产生的转运/快拆/出库单据。
// 安全：仅 Vercel cron 可调用（Authorization: Bearer CRON_SECRET）。
const DEMO_EMAIL = 'trial@atmm.store';

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    // 找体验账号用户
    let trialId = null, page = 1;
    for (;;) {
      const { data } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      const us = data?.users || [];
      const hit = us.find(u => (u.email || '').toLowerCase() === DEMO_EMAIL);
      if (hit) { trialId = hit.id; break; }
      if (us.length < 1000 || page >= 20) break;
      page++;
    }
    if (!trialId) return res.json({ ok: false, error: '体验账号不存在（' + DEMO_EMAIL + '）' });

    // 找体验仓库（该用户作为老板的仓库）
    const { data: mem } = await sb.from('warehouse_members')
      .select('warehouse_id').eq('user_id', trialId).eq('role', 'boss').maybeSingle();
    const whId = mem?.warehouse_id;
    if (!whId) return res.json({ ok: false, error: '体验仓库不存在' });

    // 清空体验产生的单据（转运/快拆/一件代发出库）
    await sb.from('atmm_pallets').delete().eq('warehouse_id', whId);
    await sb.from('atmm_orders').delete().eq('warehouse_id', whId);
    await sb.from('atmm_customers').delete().eq('warehouse_id', whId);

    // 恢复库存快照（setup 时存入 atmm_settings.data.demo_snapshot）
    let restored = false;
    const { data: st } = await sb.from('atmm_settings').select('data').eq('warehouse_id', whId).maybeSingle();
    const snap = st?.data?.demo_snapshot;
    if (snap) {
      await sb.from('warehouse_state').update({
        models: snap.models || [],
        shelf_black_table: snap.shelf_black_table || null,
        shelf_white_table: snap.shelf_white_table || null,
        pallet_table: snap.pallet_table || null,
        meta: snap.meta || null,
        updated_at: new Date().toISOString(),
      }).eq('warehouse_id', whId);
      restored = true;
    }

    return res.json({ ok: true, warehouse_id: whId, restored });
  } catch (e) {
    console.error('[cron-demo-reset] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
