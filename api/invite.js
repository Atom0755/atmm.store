const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });

  // action='setPassword' 走「为成员设置/重置登录密码」；否则走原邮件邀请。
  // 合并进同一个函数以控制 Vercel Hobby 套餐 12 个 Serverless Functions 上限。
  if ((req.body || {}).action === 'setPassword') {
    return setMemberPassword(req, res, user);
  }

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

// 老板为团队成员直接设置 / 重置登录密码（绕过邮件邀请，企业邮箱也可用）。
// 创建或更新该邮箱的 Auth 账号并设密码（email_confirm=true 免确认），并绑定到老板的仓库。
// 名额沿用 ATMM 通用规则：按订阅套餐 subscriptions.max_members 控制（与邀请一致）。
async function setMemberPassword(req, res, user) {
  const { email, password, role, warehouseId } = req.body || {};
  if (!email || !password || !role || !warehouseId)
    return res.status(400).json({ error: '缺少字段（邮箱 / 密码 / 角色 / 仓库）' });
  if (String(password).length < 8)
    return res.status(400).json({ error: '密码至少 8 位' });
  if (!['operator', 'manager'].includes(role))
    return res.status(400).json({ error: '角色只能是操作员或经理' });

  // 调用者必须是该仓库的老板
  const { data: me } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!me || me.role !== 'boss')
    return res.status(403).json({ error: '只有老板可以设置成员密码' });

  // 找该邮箱的 Auth 用户
  const { data: { users: allUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const target = allUsers?.find(u => u.email?.toLowerCase() === email.toLowerCase());

  // 名额限制：仅在「新增成员」时校验（已是成员=改密码，不重复计数）
  const { data: members } = await sb.from('warehouse_members')
    .select('user_id').eq('warehouse_id', warehouseId);
  const alreadyMember = target && (members || []).some(m => m.user_id === target.id);
  if (!alreadyMember) {
    const { data: sub } = await sb.from('subscriptions')
      .select('max_members').eq('warehouse_id', warehouseId).single();
    const total = members?.length || 0;
    if (sub && total >= sub.max_members)
      return res.status(403).json({ error: '当前方案成员数已满，请升级套餐' });
  }

  // 创建或更新账号密码
  let userId;
  if (target) {
    const { error: upErr } = await sb.auth.admin.updateUserById(target.id, { password, email_confirm: true });
    if (upErr) return res.status(500).json({ error: '设置密码失败: ' + upErr.message });
    userId = target.id;
  } else {
    const { data: created, error: cErr } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (cErr) return res.status(500).json({ error: '创建账号失败: ' + cErr.message });
    userId = created.user.id;
  }

  // 清理该用户误建的「只有自己一人」的其它仓库（确保登录后进入老板团队，而非自建新仓）
  try {
    const { data: otherMs } = await sb.from('warehouse_members')
      .select('warehouse_id, role').eq('user_id', userId).neq('warehouse_id', warehouseId);
    for (const om of (otherMs || [])) {
      if (om.role !== 'boss') continue;
      const { count } = await sb.from('warehouse_members')
        .select('id', { count: 'exact', head: true }).eq('warehouse_id', om.warehouse_id);
      if ((count || 0) <= 1) await sb.from('warehouses').delete().eq('id', om.warehouse_id); // 级联删成员
    }
  } catch (e) { /* 清理失败不阻断主流程 */ }

  // 绑定到老板的仓库
  const { error: memErr } = await sb.from('warehouse_members').upsert({
    warehouse_id: warehouseId,
    user_id: userId,
    role,
    display_name: email,
    invited_by: user.id,
  }, { onConflict: 'warehouse_id,user_id' });
  if (memErr) return res.status(500).json({ error: memErr.message });

  return res.json({ success: true, message: `${email} 的密码已设置，现在可用「邮箱 + 该密码」直接登录` });
}
