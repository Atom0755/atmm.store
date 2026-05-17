const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAIL = 'atom22628@gmail.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function sendEmailBatch(recipients) {
  if (!process.env.RESEND_API_KEY || !recipients.length) return 0;
  const from = `ATMM.store <${process.env.RESEND_FROM_EMAIL || 'noreply@atmm.store'}>`;
  let sent = 0;
  for (let i = 0; i < recipients.length; i += 50) {
    const chunk = recipients.slice(i, i + 50);
    try {
      await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(r => ({ from, to: r.email, subject: r.subject, html: r.html }))),
      });
      sent += chunk.length;
    } catch(e) { console.error('Email batch error:', e.message); }
  }
  return sent;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user || user.email !== ADMIN_EMAIL)
    return res.status(403).json({ error: 'Forbidden' });

  // ── POST: campaign management ──────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, campaign } = req.body || {};

    if (action === 'create_campaign') {
      const { name, start_date, end_date,
              max_referrals_per_warehouse = 10,
              referrer_credits = 50, referee_credits = 150 } = campaign || {};
      if (!name || !start_date || !end_date)
        return res.status(400).json({ error: '缺少必填字段' });
      const { data, error } = await sb.from('referral_campaigns')
        .insert({ name, start_date, end_date, max_referrals_per_warehouse, referrer_credits, referee_credits, active: false })
        .select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true, campaign: data });
    }

    if (action === 'activate_campaign') {
      const { id } = campaign || {};
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const { data: camp } = await sb.from('referral_campaigns').select('*').eq('id', id).single();
      if (!camp) return res.status(404).json({ error: '活动不存在' });

      await sb.from('referral_campaigns').update({ active: true }).eq('id', id);

      // Get all warehouses + boss user emails
      const { data: warehouses } = await sb.from('warehouses').select('id, name');
      const { data: bossMembers } = await sb.from('warehouse_members')
        .select('warehouse_id, user_id').eq('role', 'boss');
      const { data: { users: authUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
      const userEmailMap = {};
      (authUsers || []).forEach(u => { if (u.email) userEmailMap[u.id] = u.email; });
      const bossByWh = {};
      (bossMembers || []).forEach(m => { bossByWh[m.warehouse_id] = m.user_id; });

      const notifTitle = `🎁 推荐好友活动：${camp.name}`;
      const notifBody  = `推荐新朋友注册开仓，好友满足条件后你得 ${camp.referrer_credits} Credits，好友得 ${camp.referee_credits} Credits。活动截止：${camp.end_date}。每个账号最多可推荐 ${camp.max_referrals_per_warehouse} 人。打开 Settings → 推荐朋友 查看你的专属链接。`;

      // In-app notifications (bulk insert)
      if (warehouses?.length) {
        await sb.from('notifications').insert(
          warehouses.map(wh => ({ warehouse_id: wh.id, title: notifTitle, body: notifBody, type: 'promo', read: false }))
        );
      }

      // Emails via Resend
      const emailList = (warehouses || []).map(wh => {
        const email = userEmailMap[bossByWh[wh.id]];
        if (!email) return null;
        return {
          email,
          subject: notifTitle,
          html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:24px;">
            <h2 style="color:#d94f3b;">🎁 ${camp.name}</h2>
            <p>${notifBody.replace(/\n/g, '<br>')}</p>
            <p style="margin-top:20px;"><a href="https://atmm.store" style="background:#d94f3b;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;">打开 ATMM.store</a></p>
            <p style="font-size:11px;color:#aaa;margin-top:20px;">ATMM.store — 仓库库存管理</p>
          </div>`,
        };
      }).filter(Boolean);
      const emailed = await sendEmailBatch(emailList);

      await sb.from('referral_campaigns')
        .update({ notified_at: new Date().toISOString() }).eq('id', id);

      return res.json({ ok: true, notified: warehouses?.length ?? 0, emailed });
    }

    if (action === 'deactivate_campaign') {
      const { id } = campaign || {};
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await sb.from('referral_campaigns').update({ active: false }).eq('id', id);
      return res.json({ ok: true });
    }

    if (action === 'delete_campaign') {
      const { id } = campaign || {};
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const { count } = await sb.from('referrals')
        .select('id', { count: 'exact' }).eq('campaign_id', id);
      if ((count || 0) > 0)
        return res.status(400).json({ error: `此活动已有 ${count} 条推荐记录，无法删除` });
      await sb.from('referral_campaigns').delete().eq('id', id);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { data: { users: authUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const { data: warehouses } = await sb.from('warehouses')
      .select('id, name, owner_id, created_at, trial_ends_at');
    const { data: subscriptions } = await sb.from('subscriptions')
      .select('warehouse_id, plan, billing_cycle, status, max_members, current_period_end, updated_at');
    const { data: memberRows } = await sb.from('warehouse_members')
      .select('warehouse_id, user_id, role, display_name');

    // Referral campaigns + counts
    const { data: campaigns } = await sb.from('referral_campaigns')
      .select('id, name, start_date, end_date, max_referrals_per_warehouse, referrer_credits, referee_credits, active, notified_at, created_at')
      .order('created_at', { ascending: false });
    const { data: refRows } = await sb.from('referrals').select('campaign_id, status');
    const refCountMap = {};
    (refRows || []).forEach(r => {
      const cid = r.campaign_id || '_none';
      if (!refCountMap[cid]) refCountMap[cid] = { pending: 0, subscribed: 0, awarded: 0 };
      refCountMap[cid][r.status] = (refCountMap[cid][r.status] || 0) + 1;
    });

    const userMap = {};
    (authUsers || []).forEach(u => { userMap[u.id] = u; });
    const subMap = {};
    (subscriptions || []).forEach(s => { subMap[s.warehouse_id] = s; });
    const memberCountMap = {}, displayNameMap = {}, userWhCount = {};
    (memberRows || []).forEach(m => {
      memberCountMap[m.warehouse_id] = (memberCountMap[m.warehouse_id] || 0) + 1;
      if (m.display_name && !displayNameMap[m.user_id]) displayNameMap[m.user_id] = m.display_name;
    });
    (warehouses || []).forEach(wh => {
      userWhCount[wh.owner_id] = (userWhCount[wh.owner_id] || 0) + 1;
    });

    const rows = (warehouses || []).map(wh => {
      const owner = userMap[wh.owner_id] || {};
      const sub   = subMap[wh.id] || {};
      return {
        warehouse_id: wh.id, warehouse_name: wh.name,
        owner_email: owner.email || wh.owner_id,
        registered_at: owner.created_at || null, trial_ends_at: wh.trial_ends_at || null,
        wh_created_at: wh.created_at, plan: sub.plan || 'trial',
        billing_cycle: sub.billing_cycle || null, sub_status: sub.status || 'trial',
        max_members: sub.max_members || 1, member_count: memberCountMap[wh.id] || 0,
        period_end: sub.current_period_end || null,
      };
    });

    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60);
    const dailyMap = {};
    (authUsers || []).forEach(u => {
      const d = (u.created_at || '').slice(0, 10);
      if (d && new Date(d) >= cutoff) dailyMap[d] = (dailyMap[d] || 0) + 1;
    });
    const daily = Object.entries(dailyMap).sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));

    const users = (authUsers || []).map(u => ({
      id: u.id, email: u.email || '', phone: u.phone || '',
      display_name: displayNameMap[u.id] || '',
      registered_at: u.created_at || null, wh_count: userWhCount[u.id] || 0,
    })).sort((a, b) => (b.registered_at || '').localeCompare(a.registered_at || ''));

    res.json({
      total_users: (authUsers || []).length,
      total_warehouses: (warehouses || []).length,
      rows, daily, users,
      campaigns: (campaigns || []).map(c => ({ ...c, referral_counts: refCountMap[c.id] || { pending:0, subscribed:0, awarded:0 } })),
    });
  } catch (e) {
    console.error('admin-stats error:', e);
    res.status(500).json({ error: e.message });
  }
};
