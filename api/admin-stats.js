const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAIL = 'atom22628@gmail.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify caller is the platform admin
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user || user.email !== ADMIN_EMAIL)
    return res.status(403).json({ error: 'Forbidden' });

  try {
    // 1. All registered users
    const { data: { users: authUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });

    // 2. All warehouses
    const { data: warehouses } = await sb.from('warehouses')
      .select('id, name, owner_id, created_at, trial_ends_at');

    // 3. All subscriptions
    const { data: subscriptions } = await sb.from('subscriptions')
      .select('warehouse_id, plan, billing_cycle, status, max_members, current_period_end, updated_at');

    // 4. All members (for counts + display_name lookup)
    const { data: memberRows } = await sb.from('warehouse_members')
      .select('warehouse_id, user_id, role, display_name');

    // Build lookup maps
    const userMap = {};
    (authUsers || []).forEach(u => { userMap[u.id] = u; });

    const subMap = {};
    (subscriptions || []).forEach(s => { subMap[s.warehouse_id] = s; });

    const memberCountMap = {};
    const displayNameMap = {};   // user_id → display_name (from any warehouse)
    const userWhCount = {};      // user_id → number of warehouses they own
    (memberRows || []).forEach(m => {
      memberCountMap[m.warehouse_id] = (memberCountMap[m.warehouse_id] || 0) + 1;
      if (m.display_name && !displayNameMap[m.user_id]) displayNameMap[m.user_id] = m.display_name;
    });
    (warehouses || []).forEach(wh => {
      userWhCount[wh.owner_id] = (userWhCount[wh.owner_id] || 0) + 1;
    });

    // Build per-warehouse rows
    const rows = (warehouses || []).map(wh => {
      const owner = userMap[wh.owner_id] || {};
      const sub   = subMap[wh.id] || {};
      return {
        warehouse_id:      wh.id,
        warehouse_name:    wh.name,
        owner_email:       owner.email || wh.owner_id,
        registered_at:     owner.created_at || null,
        trial_ends_at:     wh.trial_ends_at || null,
        wh_created_at:     wh.created_at,
        plan:              sub.plan || 'trial',
        billing_cycle:     sub.billing_cycle || null,
        sub_status:        sub.status || 'trial',
        max_members:       sub.max_members || 1,
        member_count:      memberCountMap[wh.id] || 0,
        period_end:        sub.current_period_end || null,
      };
    });

    // Daily registration counts (last 60 days, grouped by date)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const dailyMap = {};
    (authUsers || []).forEach(u => {
      const d = (u.created_at || '').slice(0, 10);
      if (d && new Date(d) >= cutoff) dailyMap[d] = (dailyMap[d] || 0) + 1;
    });
    const daily = Object.entries(dailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, count }));

    // Full user list for admin panel
    const users = (authUsers || []).map(u => ({
      id:           u.id,
      email:        u.email || '',
      phone:        u.phone || '',
      display_name: displayNameMap[u.id] || '',
      registered_at:u.created_at || null,
      wh_count:     userWhCount[u.id] || 0,
    })).sort((a, b) => (b.registered_at || '').localeCompare(a.registered_at || ''));

    res.json({
      total_users: (authUsers || []).length,
      total_warehouses: (warehouses || []).length,
      rows,
      daily,
      users,
    });
  } catch (e) {
    console.error('admin-stats error:', e);
    res.status(500).json({ error: e.message });
  }
};
