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
    // List all users and find those without email
    const { data: { users: allUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const anon = (allUsers || []).filter(u => !u.email);

    const results = [];
    for (const u of anon) {
      const { error } = await sb.auth.admin.deleteUser(u.id);
      results.push({ id: u.id, ok: !error, err: error?.message });
    }

    const deleted = results.filter(r => r.ok).length;
    const failed  = results.filter(r => !r.ok).length;
    res.json({ deleted, failed, total: anon.length, results });
  } catch (e) {
    console.error('admin-delete-anon error:', e);
    res.status(500).json({ error: e.message });
  }
};
