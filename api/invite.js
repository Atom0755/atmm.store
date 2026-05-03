const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
  const redirectTo = `${origin}/?invite_warehouse=${warehouseId}&invite_role=${role}`;

  // Check if this email is already a registered user
  const { data: { users: allUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const existingUser = allUsers?.find(u => u.email?.toLowerCase() === email.toLowerCase());

  if (existingUser) {
    // Already registered — add them directly to warehouse_members
    const { error: memberErr } = await sb.from('warehouse_members').upsert({
      warehouse_id: warehouseId,
      user_id: existingUser.id,
      role,
      display_name: existingUser.email,
      invited_by: user.id,
    }, { onConflict: 'warehouse_id,user_id' });

    if (memberErr)
      return res.status(500).json({ error: memberErr.message });

    return res.json({ success: true, message: `${email} 已加入仓库（已注册用户，直接添加）` });
  }

  // New user — send invite email via Supabase Auth
  const { error: invErr } = await sb.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { warehouse_id: warehouseId, invite_role: role },
  });

  if (invErr) {
    // Fallback: store invitation record so user can join via invite code manually
    await sb.from('invitations').insert({
      warehouse_id: warehouseId,
      email,
      role,
      invited_by: user.id,
    });
    return res.json({ success: true, message: `邀请链接已生成，邮件发送可能有延迟` });
  }

  res.json({ success: true, message: `邀请邮件已发送至 ${email}` });
};
