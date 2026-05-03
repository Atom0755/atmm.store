const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { email, role, warehouseId } = req.body || {};
  if (!email || !role || !warehouseId)
    return res.status(400).json({ error: 'Missing fields' });

  // Only boss can invite
  const { data: me } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!me || me.role !== 'boss')
    return res.status(403).json({ error: '只有老板可以邀请成员' });

  // Check plan allows more members
  const { data: sub } = await sb.from('subscriptions')
    .select('max_members, status').eq('warehouse_id', warehouseId).single();
  const { count } = await sb.from('warehouse_members')
    .select('*', { count: 'exact', head: true }).eq('warehouse_id', warehouseId);

  if (sub && count >= sub.max_members)
    return res.status(403).json({ error: '当前方案成员数已满，请升级套餐' });

  const origin = req.headers.origin || 'https://atmm.store';

  // Use Supabase's built-in invite (sends email automatically)
  try {
    await sb.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${origin}/?invite_warehouse=${warehouseId}&invite_role=${role}`,
      data: { warehouse_id: warehouseId, invite_role: role },
    });
  } catch (e) {
    // User may already exist — create invitation record for manual flow
    const { error: invErr } = await sb.from('invitations').insert({
      warehouse_id: warehouseId,
      email,
      role,
      invited_by: user.id,
    });
    if (invErr) return res.status(500).json({ error: invErr.message });
  }

  res.json({ success: true, message: `邀请已发送至 ${email}` });
};
