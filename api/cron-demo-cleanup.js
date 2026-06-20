const { createClient } = require('@supabase/supabase-js');

// 清理超过 7 天的方法B体验账号（删 Auth 用户 + 仓库级联删数据 + atmm_demo 记录）。
// 安全：仅 Vercel cron 可调用（Authorization: Bearer CRON_SECRET）。
module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: olds } = await sb.from('atmm_demo')
      .select('id,user_id,warehouse_id').lt('created_at', cutoff).limit(500);
    let removed = 0;
    for (const d of (olds || [])) {
      try {
        if (d.warehouse_id) await sb.from('warehouses').delete().eq('id', d.warehouse_id); // 级联删成员/状态/订阅/单据
        if (d.user_id) { try { await sb.auth.admin.deleteUser(d.user_id); } catch (e) {} }
        await sb.from('atmm_demo').delete().eq('id', d.id);
        removed++;
      } catch (e) { console.error('[cron-demo-cleanup] row', d.id, e.message); }
    }
    return res.json({ ok: true, removed });
  } catch (e) {
    console.error('[cron-demo-cleanup] fatal:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
