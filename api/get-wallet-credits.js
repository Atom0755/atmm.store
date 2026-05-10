const { createClient } = require('@supabase/supabase-js');

const CREDITS_PER_DOLLAR    = 12;
const DEFAULT_REFERRER_CRED = 50;
const DEFAULT_REFEREE_CRED  = 150;

async function awardCredits(sb, warehouseId, amount, description) {
  const { data: cr } = await sb.from('credits').select('id,balance').eq('warehouse_id', warehouseId).maybeSingle();
  const current = cr?.balance ?? 0;
  if (cr?.id) {
    await sb.from('credits').update({ balance: current + amount, updated_at: new Date().toISOString() }).eq('id', cr.id);
  } else {
    await sb.from('credits').insert({ warehouse_id: warehouseId, balance: amount, updated_at: new Date().toISOString() });
  }
  await sb.from('warehouse_credit_transactions').insert({
    warehouse_id: warehouseId, type: 'referral', amount, description,
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  // ── POST actions ──────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, warehouseId, refCode, creditsAmount } = req.body || {};
    if (!warehouseId) return res.status(400).json({ error: 'Missing warehouseId' });

    const { data: member } = await sb.from('warehouse_members')
      .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
    if (!member) return res.status(403).json({ error: 'Forbidden' });

    // Record referral (requires active campaign)
    if (action === 'record_referral') {
      if (!refCode) return res.status(400).json({ error: 'Missing refCode' });

      // Find active campaign for today
      const today = new Date().toISOString().slice(0, 10);
      const { data: camps } = await sb.from('referral_campaigns')
        .select('id, max_referrals_per_warehouse')
        .eq('active', true)
        .lte('start_date', today)
        .gte('end_date', today)
        .limit(1);
      const campaign = camps?.[0] || null;

      // Prevent self-referral
      const { data: refWh } = await sb.from('warehouses').select('id').eq('code', refCode).maybeSingle();
      if (!refWh || refWh.id === warehouseId) return res.json({ ok: true, skipped: true });

      // Only one referral per warehouse (as referee)
      const { data: existing } = await sb.from('referrals')
        .select('id').eq('referee_warehouse_id', warehouseId).maybeSingle();
      if (existing) return res.json({ ok: true, skipped: true });

      // Check referrer's per-campaign limit (default 10)
      if (campaign) {
        const { count } = await sb.from('referrals')
          .select('id', { count: 'exact' })
          .eq('referrer_code', refCode)
          .eq('campaign_id', campaign.id);
        if ((count || 0) >= (campaign.max_referrals_per_warehouse ?? 10))
          return res.json({ ok: true, skipped: true, reason: 'referrer_limit_reached' });
      }

      await sb.from('referrals').insert({
        referee_warehouse_id: warehouseId,
        referrer_code: refCode,
        status: 'pending',
        campaign_id: campaign?.id || null,
      });
      return res.json({ ok: true, campaign_active: !!campaign });
    }

    // Convert credits → wallet (12 credits = $1)
    if (action === 'credits_to_wallet') {
      if (member.role !== 'boss') return res.status(403).json({ error: 'Only boss can convert' });
      const amt = parseInt(creditsAmount, 10) || 0;
      if (amt < CREDITS_PER_DOLLAR)
        return res.status(400).json({ error: `最少兑换 ${CREDITS_PER_DOLLAR} Credits` });
      const useCredits = Math.floor(amt / CREDITS_PER_DOLLAR) * CREDITS_PER_DOLLAR;
      const earnCents  = Math.floor(amt / CREDITS_PER_DOLLAR) * 100;
      const { data: cr } = await sb.from('credits').select('id,balance').eq('warehouse_id', warehouseId).maybeSingle();
      if (!cr || cr.balance < useCredits) return res.status(400).json({ error: '积分余额不足' });
      await sb.from('credits').update({ balance: cr.balance - useCredits, updated_at: new Date().toISOString() }).eq('id', cr.id);
      await sb.from('warehouse_credit_transactions').insert({
        warehouse_id: warehouseId, type: 'conversion',
        amount: -useCredits, description: `积分兑换入钱包 ${useCredits} Credits → $${(earnCents/100).toFixed(2)}`,
      });
      const { data: walletRow } = await sb.from('wallets').select('id,balance_cents').eq('warehouse_id', warehouseId).maybeSingle();
      const cur = walletRow?.balance_cents ?? 0;
      if (walletRow?.id) {
        await sb.from('wallets').update({ balance_cents: cur + earnCents, updated_at: new Date().toISOString() }).eq('id', walletRow.id);
      } else {
        await sb.from('wallets').insert({ warehouse_id: warehouseId, balance_cents: earnCents });
      }
      await sb.from('warehouse_transactions').insert({
        warehouse_id: warehouseId, type: 'topup',
        amount_cents: earnCents, description: `积分兑换 ${useCredits} Credits → $${(earnCents/100).toFixed(2)}`,
      });
      return res.json({ ok: true, wallet_cents: cur + earnCents, credits: cr.balance - useCredits });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const warehouseId = req.query.warehouse_id;
  if (!warehouseId) return res.status(400).json({ error: 'Missing warehouse_id' });

  const { data: member } = await sb.from('warehouse_members')
    .select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
  if (!member) return res.status(403).json({ error: 'Forbidden' });

  // Lazy referral award: this warehouse is the referee
  try {
    const { data: pendingRefs } = await sb.from('referrals')
      .select('id, referrer_code, subscribed_at, campaign_id, referral_campaigns(referrer_credits, referee_credits)')
      .eq('referee_warehouse_id', warehouseId)
      .eq('status', 'subscribed');

    for (const ref of (pendingRefs || [])) {
      if (!ref.subscribed_at) continue;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (new Date(ref.subscribed_at) > sevenDaysAgo) continue;
      const { data: wstate } = await sb.from('warehouse_state')
        .select('models').eq('warehouse_id', warehouseId).maybeSingle();
      if (!wstate?.models?.length) continue;

      const refereeCred  = ref.referral_campaigns?.referee_credits  ?? DEFAULT_REFEREE_CRED;
      const referrerCred = ref.referral_campaigns?.referrer_credits ?? DEFAULT_REFERRER_CRED;

      await awardCredits(sb, warehouseId, refereeCred, `推荐活动奖励 — 好友推荐开仓 +${refereeCred} Credits`);
      const { data: referrerWh } = await sb.from('warehouses').select('id').eq('code', ref.referrer_code).maybeSingle();
      if (referrerWh?.id) {
        await awardCredits(sb, referrerWh.id, referrerCred, `推荐活动奖励 — 你推荐的好友开仓成功 +${referrerCred} Credits`);
      }
      await sb.from('referrals').update({ status: 'awarded', awarded_at: new Date().toISOString() }).eq('id', ref.id);
    }
  } catch (e) {
    console.error('[gwc] referral check error:', e.message);
  }

  // Wallet + credits
  const { data: walletRow } = await sb.from('wallets').select('balance_cents').eq('warehouse_id', warehouseId).maybeSingle();
  const { data: creditsRow } = await sb.from('credits').select('balance').eq('warehouse_id', warehouseId).maybeSingle();

  // Referral stats (as referrer)
  const { data: whData } = await sb.from('warehouses').select('code').eq('id', warehouseId).maybeSingle();
  let referral_stats = { total: 0, awarded: 0 };
  if (whData?.code) {
    const { data: myRefs } = await sb.from('referrals').select('status').eq('referrer_code', whData.code);
    referral_stats.total   = myRefs?.length ?? 0;
    referral_stats.awarded = myRefs?.filter(r => r.status === 'awarded').length ?? 0;
  }

  // Active campaign (for UI display)
  const today = new Date().toISOString().slice(0, 10);
  const { data: activeCamps } = await sb.from('referral_campaigns')
    .select('id, name, start_date, end_date, max_referrals_per_warehouse, referrer_credits, referee_credits')
    .eq('active', true).lte('start_date', today).gte('end_date', today).limit(1);
  const active_campaign = activeCamps?.[0] || null;

  // Unread notifications count (before marking read)
  const { data: notifRows } = await sb.from('notifications')
    .select('id, title, body, type, read, created_at')
    .eq('warehouse_id', warehouseId)
    .order('created_at', { ascending: false }).limit(10);
  const unreadIds = (notifRows || []).filter(n => !n.read).map(n => n.id);
  const new_notifications = unreadIds.length;
  if (unreadIds.length) {
    await sb.from('notifications').update({ read: true }).in('id', unreadIds);
  }

  // Transaction history
  const { data: walletTxs } = await sb.from('warehouse_transactions')
    .select('type,amount_cents,description,created_at')
    .eq('warehouse_id', warehouseId)
    .order('created_at', { ascending: false }).limit(10);
  const { data: creditTxs } = await sb.from('warehouse_credit_transactions')
    .select('type,amount,description,created_at')
    .eq('warehouse_id', warehouseId)
    .order('created_at', { ascending: false }).limit(10);

  res.json({
    wallet_cents: walletRow?.balance_cents ?? 0,
    credits: creditsRow?.balance ?? 0,
    referral_stats,
    active_campaign,
    notifications: notifRows || [],
    new_notifications,
    wallet_transactions: walletTxs || [],
    credit_transactions: creditTxs || [],
  });
};
