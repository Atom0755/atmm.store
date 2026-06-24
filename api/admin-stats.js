const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ADMIN_EMAIL = 'atom22628@gmail.com';

// ATMM 管理后台数据：用户 / 仓库 / 订阅 / 注册趋势。仅管理员可访问。
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL)
    return res.status(403).json({ error: '无权限：仅管理员可访问' });

  // 推荐返利活动管理（次要功能，暂未启用）
  if (req.method === 'POST') {
    return res.json({ ok: false, error: '活动管理暂未启用' });
  }

  try {
    // 所有 Auth 用户（分页）
    let allUsers = [], page = 1;
    for (;;) {
      const { data } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      const us = data?.users || [];
      allUsers = allUsers.concat(us);
      if (us.length < 1000 || page >= 20) break;
      page++;
    }
    const emailById = {};
    const users = allUsers.map(u => {
      emailById[u.id] = u.email || '';
      return {
        id: u.id,
        email: u.email || '',
        display_name: (u.user_metadata && (u.user_metadata.display_name || u.user_metadata.name)) || '',
        registered_at: u.created_at,
      };
    });
    // 体验账号(@atmm.store)不计入真实注册，单独统计
    const isDemoEmail = e => (e || '').toLowerCase().endsWith('@atmm.store');
    const realUsers = users.filter(u => !isDemoEmail(u.email));
    const total_users = realUsers.length;
    // 体验访客累计 = 历史发出的最大 trial 编号（永不下降；老账号删除也不回退）
    let demo_count = 0;
    try {
      const { data: maxRow } = await sb.from('atmm_demo')
        .select('id').order('id', { ascending: false }).limit(1).maybeSingle();
      if (maxRow) demo_count = Number(maxRow.id) || 0;
    } catch (e) { /* 表未建则 0 */ }

    // 注册趋势（按天，仅真实用户）
    const dailyMap = {};
    for (const u of realUsers) {
      const d = (u.registered_at || '').slice(0, 10);
      if (d) dailyMap[d] = (dailyMap[d] || 0) + 1;
    }
    const daily = Object.entries(dailyMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    // 仓库 + 成员 + 订阅
    const { data: whs } = await sb.from('warehouses').select('id,name,created_at');
    const { data: mems } = await sb.from('warehouse_members').select('warehouse_id,user_id,role');
    const { data: subs } = await sb.from('subscriptions')
      .select('warehouse_id,plan,status,max_members,current_period_end');

    const subByWh = {}; (subs || []).forEach(s => { subByWh[s.warehouse_id] = s; });
    const memberCount = {}, bossByWh = {}, whCountByUser = {};
    (mems || []).forEach(m => {
      memberCount[m.warehouse_id] = (memberCount[m.warehouse_id] || 0) + 1;
      whCountByUser[m.user_id] = (whCountByUser[m.user_id] || 0) + 1;
      if (m.role === 'boss') bossByWh[m.warehouse_id] = m.user_id;
    });
    // 有仓库成员关系 = ATMM.store 用户；无 = ZEHEM.AI 用户
    users.forEach(u => { u.wh_count = whCountByUser[u.id] || 0; });
    // 用户编号 + ZEHEM 资料卡（后台弹窗内嵌显示，不依赖 ZEHEM 端权限）
    try {
      const { data: profs } = await sb.from('profiles').select('*');   // 服务密钥读取，绕过 RLS
      const pById = {}; (profs || []).forEach(p => { pById[p.id] = p; });
      const PICK = ['user_number','username','nickname','full_name','avatar_url','bio',
        'signature','website','phone','email_contact','wechat','job','city','created_at','coins'];
      users.forEach(u => {
        const p = pById[u.id];
        u.user_number = p ? (p.user_number || null) : null;
        if (p) {
          u.zehem = {};
          PICK.forEach(k => { if (p[k] !== undefined && p[k] !== null && p[k] !== '') u.zehem[k] = p[k]; });
        }
      });
    } catch (e) { /* 忽略 */ }

    const rows = (whs || []).map(w => {
      const s = subByWh[w.id] || {};
      return {
        warehouse_id: w.id,
        warehouse_name: w.name,
        owner_email: emailById[bossByWh[w.id]] || '',
        registered_at: w.created_at,
        trial_ends_at: null,
        sub_status: s.status || '—',
        plan: s.plan || '—',
        period_end: s.current_period_end || null,
        member_count: memberCount[w.id] || 0,
      };
    }).filter(r => !isDemoEmail(r.owner_email));   // 体验仓库不进明细
    const total_warehouses = rows.length;

    // 访问流量（site_visits；表不存在则返回 0，不报错）
    let traffic_today = 0, traffic_7d = 0, traffic_30d = 0;
    try {
      const now = Date.now();
      const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
      const d7 = new Date(now - 7 * 86400000).toISOString();
      const d30 = new Date(now - 30 * 86400000).toISOString();
      const cnt = async (since) => {
        const { count } = await sb.from('atmm_visits')
          .select('id', { count: 'exact', head: true }).gte('created_at', since);
        return count || 0;
      };
      traffic_today = await cnt(todayStart);
      traffic_7d = await cnt(d7);
      traffic_30d = await cnt(d30);
    } catch (e) { /* 表未建则忽略 */ }

    // 访客来源：最近访客 + 国家分布（近30天）
    let visits = [], visit_countries = [];
    try {
      const now2 = Date.now();
      const d30b = new Date(now2 - 30 * 86400000).toISOString();
      const { data: vs } = await sb.from('atmm_visits')
        .select('created_at,country,city,region,ref,ua,lang,email,path')
        .order('created_at', { ascending: false }).limit(80);
      visits = vs || [];
      const { data: vc } = await sb.from('atmm_visits').select('country').gte('created_at', d30b);
      const cmap = {};
      (vc || []).forEach(v => { const c = v.country || '未知'; cmap[c] = (cmap[c] || 0) + 1; });
      visit_countries = Object.entries(cmap).map(([country, count]) => ({ country, count }))
        .sort((a, b) => b.count - a.count).slice(0, 12);
    } catch (e) { /* 忽略 */ }

    // 体验账号明细（按编号倒序）
    let demo_list = [];
    try {
      const { data: dl } = await sb.from('atmm_demo')
        .select('id,email,created_at').order('id', { ascending: false }).limit(300);
      demo_list = (dl || []).filter(d => d.email);
    } catch (e) { /* 表未建则忽略 */ }

    res.json({ total_users, total_warehouses, demo_count, daily, users: realUsers, rows, campaigns: [],
      traffic_today, traffic_7d, traffic_30d, visits, visit_countries, demo_list });
  } catch (e) {
    console.error('admin-stats error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
};
