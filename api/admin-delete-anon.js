const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAIL = 'atom22628@gmail.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user || user.email !== ADMIN_EMAIL)
    return res.status(403).json({ error: 'Forbidden' });

  try {
    const { data: { users: allUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const anon = (allUsers || []).filter(u => !u.email);

    const results = [];
    for (const u of anon) {
      try {
        // Clean up application data before deleting auth user
        await sb.from('warehouse_members').delete().eq('user_id', u.id);

        // Find warehouses owned by this user and clean them up
        const { data: ownedWh } = await sb.from('warehouses').select('id').eq('owner_id', u.id);
        if (ownedWh && ownedWh.length > 0) {
          const whIds = ownedWh.map(w => w.id);
          await sb.from('warehouse_members').delete().in('warehouse_id', whIds);
          await sb.from('subscriptions').delete().in('warehouse_id', whIds);
          await sb.from('warehouses').delete().in('id', whIds);
        }

        const { error } = await sb.auth.admin.deleteUser(u.id, false);
        results.push({ id: u.id, phone: u.phone || '', ok: !error, err: error?.message || null });
      } catch (e) {
        results.push({ id: u.id, phone: u.phone || '', ok: false, err: e.message });
      }
    }

    const deleted = results.filter(r => r.ok).length;
    const failed  = results.filter(r => !r.ok);
    res.json({ deleted, failed: failed.length, total: anon.length, results, failDetails: failed });
  } catch (e) {
    console.error('admin-delete-anon error:', e);
    res.status(500).json({ error: e.message });
  }
};
