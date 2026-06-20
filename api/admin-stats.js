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
    const total_users = users.length;

    // 注册趋势（按天）
    const dailyMap = {};
    for (const u of users) {
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
    const memberCount = {}, bossByWh = {};
    (mems || []).forEach(m => {
      memberCount[m.warehouse_id] = (memberCount[m.warehouse_id] || 0) + 1;
      if (m.role === 'boss') bossByWh[m.warehouse_id] = m.user_id;
    });

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
    });
    const total_warehouses = (whs || []).length;

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

    res.json({ total_users, total_warehouses, daily, users, rows, campaigns: [],
      traffic_today, traffic_7d, traffic_30d });
  } catch (e) {
    console.error('admin-stats error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
};
