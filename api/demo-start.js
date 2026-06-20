const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 方法B：每个访客（按浏览器设备标识）自动开一个独立体验沙盒账号。
// 账号 trialNNNNN@atmm.store（从10001起、独立计数），密码统一，2天有效，7天内同设备不可再生成。
const DEMO_PASSWORD = 'Trial123456';
const TEMPLATE_WH = 'b3d5f647-dda4-4434-9283-8700f96e4682'; // 克隆示例数据的模板仓库
const VALID_DAYS = 2, BLOCK_DAYS = 7;

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const device_id = ((req.body || {}).device_id || '').slice(0, 80);
    if (!device_id) return res.json({ error: '缺少设备标识' });
    const now = Date.now();

    // 该设备最近的体验账号
    const { data: last } = await sb.from('atmm_demo')
      .select('*').eq('device_id', device_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (last && last.email) {
      const age = now - new Date(last.created_at).getTime();
      if (age < VALID_DAYS * 86400000) {
        return res.json({ ok: true, email: last.email, password: DEMO_PASSWORD, resume: true });
      }
      if (age < BLOCK_DAYS * 86400000) {
        return res.json({ blocked: true });
      }
      // 超过 7 天，允许重新生成
    }

    // 生成新体验账号
    const { data: ins, error: insErr } = await sb.from('atmm_demo').insert({ device_id }).select('id').single();
    if (insErr) throw insErr;
    const num = 10000 + Number(ins.id);
    const email = `trial${num}@atmm.store`;

    const { data: created, error: cErr } = await sb.auth.admin.createUser({ email, password: DEMO_PASSWORD, email_confirm: true });
    if (cErr) throw cErr;
    const uid = created.user.id;

    const { data: wh, error: wErr } = await sb.from('warehouses').insert({ name: `体验仓库 ${num}`, owner_id: uid }).select('id').single();
    if (wErr) throw wErr;
    await sb.from('warehouse_members').insert({ warehouse_id: wh.id, user_id: uid, role: 'boss', display_name: '体验访客' });
    await sb.from('subscriptions').upsert({
      warehouse_id: wh.id, plan: 'premium', status: 'active', max_members: 1,
      modules: ['yijian', 'zhuanyun'], current_period_end: new Date(now + VALID_DAYS * 86400000).toISOString(),
    }, { onConflict: 'warehouse_id' });

    // 克隆示例库存数据
    try {
      const { data: st } = await sb.from('warehouse_state')
        .select('models,shelf_black_table,shelf_white_table,pallet_table,meta')
        .eq('warehouse_id', TEMPLATE_WH).maybeSingle();
      if (st) await sb.from('warehouse_state').upsert(Object.assign({ warehouse_id: wh.id }, st), { onConflict: 'warehouse_id' });
    } catch (e) { /* 克隆失败不阻断 */ }

    await sb.from('atmm_demo').update({ email, user_id: uid, warehouse_id: wh.id }).eq('id', ins.id);
    res.json({ ok: true, email, password: DEMO_PASSWORD, resume: false });
  } catch (e) {
    console.error('[demo-start] error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
