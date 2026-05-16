const { createClient } = require('@supabase/supabase-js');

const CREDITS_PER_DOLLAR    = 12;
const DEFAULT_REFERRER_CRED = 50;
const DEFAULT_REFEREE_CRED  = 150;

// Award credits to the boss user of a warehouse (used by referral system)
async function awardCreditsToWarehouseBoss(sb, warehouseId, amount, description) {
  // Find boss user for this warehouse
  const { data: member } = await sb.from('warehouse_members')
    .select('user_id').eq('warehouse_id', warehouseId).eq('role', 'boss').maybeSingle();
  const userId = member?.user_id;
  if (!userId) return;

  // Update profiles.coins
  const { data: prof } = await sb.from('profiles').select('coins').eq('id', userId).maybeSingle();
  const current = prof?.coins ?? 0;
  await sb.from('profiles').update({ coins: current + amount }).eq('id', userId);

  // Record in coins_transactions
  await sb.from('coins_transactions').insert({ user_id: userId, amount, description });
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
      const today = new Date().toISOString().slice(0, 10);
      const { data: camps } = await sb.from('referral_campaigns')
        .select('id, max_referrals_per_warehouse')
        .eq('active', true).lte('start_date', today).gte('end_date', today).limit(1);
      const campaign = camps?.[0] || null;
      const { data: refWh } = await sb.from('warehouses').select('id').eq('code', refCode).maybeSingle();
      if (!refWh || refWh.id === warehouseId) return res.json({ ok: true, skipped: true });
      const { data: existing } = await sb.from('referrals')
        .select('id').eq('referee_warehouse_id', warehouseId).maybeSingle();
      if (existing) return res.json({ ok: true, skipped: true });
      if (campaign) {
        const { count } = await sb.from('referrals')
          .select('id', { count: 'exact' }).eq('referrer_code', refCode).eq('campaign_id', campaign.id);
        if ((count || 0) >= (campaign.max_referrals_per_warehouse ?? 10))
          return res.json({ ok: true, skipped: true, reason: 'referrer_limit_reached' });
      }
      await sb.from('referrals').insert({
        referee_warehouse_id: warehouseId, referrer_code: refCode,
        status: 'pending', campaign_id: campaign?.id || null,
      });
      return res.json({ ok: true, campaign_active: !!campaign });
    }

    // Convert Z Credits → wallet balance (12 credits = $1)
    if (action === 'credits_to_wallet') {
      if (member.role !== 'boss') return res.status(403).json({ error: 'Only boss can convert' });
      const amt = parseInt(creditsAmount, 10) || 0;
      if (amt < CREDITS_PER_DOLLAR)
        return res.status(400).json({ error: `最少兑换 ${CREDITS_PER_DOLLAR} Credits` });
      const useCredits = Math.floor(amt / CREDITS_PER_DOLLAR) * CREDITS_PER_DOLLAR;
      const earnCents  = Math.floor(amt / CREDITS_PER_DOLLAR) * 100;

      // Check credits balance in profiles.coins
      const { data: prof } = await sb.from('profiles').select('coins').eq('id', user.id).maybeSingle();
      const curCoins = prof?.coins ?? 0;
      if (curCoins < useCredits) return res.status(400).json({ error: '积分余额不足' });

      // Deduct from profiles.coins
      await sb.from('profiles').update({ coins: curCoins - useCredits }).eq('id', user.id);
      await sb.from('coins_transactions').insert({
        user_id: user.id, amount: -useCredits,
        description: `积分兑换入钱包 ${useCredits} Z Credits → $${(earnCents/100).toFixed(2)}`,
      });

      // Add to user_wallets
      const { data: wRow } = await sb.from('user_wallets').select('balance_cents').eq('user_id', user.id).maybeSingle();
      const curWal = wRow?.balance_cents ?? 0;
      if (wRow) {
        await sb.from('user_wallets').update({ balance_cents: curWal + earnCents, updated_at: new Date().toISOString() }).eq('user_id', user.id);
      } else {
        await sb.from('user_wallets').insert({ user_id: user.id, balance_cents: earnCents, updated_at: new Date().toISOString() });
      }
      await sb.from('wallet_transactions').insert({
        user_id: user.id, amount_cents: earnCents,
        description: `积分兑换 ${useCredits} Z Credits → $${(earnCents/100).toFixed(2)}`,
      });

      return res.json({ ok: true, wallet_cents: curWal + earnCents, credits: curCoins - useCredits });
    }

    // Convert wallet balance → Z Credits ($1 = 12 credits)
    if (action === 'wallet_to_credits') {
      if (member.role !== 'boss') return res.status(403).json({ error: 'Only boss can convert' });
      const amtUsd = parseFloat(req.body.amountUsd || 0);
      if (!amtUsd || amtUsd < 1) return res.status(400).json({ error: '最少兑换 $1' });
      const deductCents = Math.round(amtUsd * 100);
      const earnCredits = Math.round(amtUsd * CREDITS_PER_DOLLAR);

      // Check user_wallets balance
      const { data: wRow } = await sb.from('user_wallets').select('balance_cents').eq('user_id', user.id).maybeSingle();
      const curWal = wRow?.balance_cents ?? 0;
      if (curWal < deductCents) return res.status(400).json({ error: '钱包余额不足' });

      // Deduct from user_wallets
      await sb.from('user_wallets').update({ balance_cents: curWal - deductCents, updated_at: new Date().toISOString() }).eq('user_id', user.id);
      await sb.from('wallet_transactions').insert({
        user_id: user.id, amount_cents: -deductCents,
        description: `兑换 ${earnCredits} Z Credits`,
      });

      // Add to profiles.coins
      const { data: prof } = await sb.from('profiles').select('coins').eq('id', user.id).maybeSingle();
      const curCoins = prof?.coins ?? 0;
      await sb.from('profiles').update({ coins: curCoins + earnCredits }).eq('id', user.id);
      await sb.from('coins_transactions').insert({
        user_id: user.id, amount: earnCredits,
        description: `从钱包兑换 $${amtUsd}`,
      });

      return res.json({ ok: true, wallet_cents: curWal - deductCents, credits: curCoins + earnCredits });
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

  // Lazy referral award: this warehouse is the referee (uses boss user credit)
  try {
    const { data: pendingRefs } = await sb.from('referrals')
      .select('id, referrer_code, subscribed_at, campaign_id, referral_campaigns(referrer_credits, referee_credits)')
      .eq('referee_warehouse_id', warehouseId).eq('status', 'subscribed');

    for (const ref of (pendingRefs || [])) {
      if (!ref.subscribed_at) continue;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (new Date(ref.subscribed_at) > sevenDaysAgo) continue;
      const { data: wstate } = await sb.from('warehouse_state')
        .select('models').eq('warehouse_id', warehouseId).maybeSingle();
      if (!wstate?.models?.length) continue;

      const refereeCred  = ref.referral_campaigns?.referee_credits  ?? DEFAULT_REFEREE_CRED;
      const referrerCred = ref.referral_campaigns?.referrer_credits ?? DEFAULT_REFERRER_CRED;

      await awardCreditsToWarehouseBoss(sb, warehouseId, refereeCred, `推荐活动奖励 — 好友推荐开仓 +${refereeCred} Z Credits`);
      const { data: referrerWh } = await sb.from('warehouses').select('id').eq('code', ref.referrer_code).maybeSingle();
      if (referrerWh?.id) {
        await awardCreditsToWarehouseBoss(sb, referrerWh.id, referrerCred, `推荐活动奖励 — 你推荐的好友开仓成功 +${referrerCred} Z Credits`);
      }
      await sb.from('referrals').update({ status: 'awarded', awarded_at: new Date().toISOString() }).eq('id', ref.id);
    }
  } catch (e) {
    console.error('[gwc] referral check error:', e.message);
  }

  // ── Read from unified user-based tables ──
  const { data: walletRow } = await sb.from('user_wallets').select('balance_cents').eq('user_id', user.id).maybeSingle();
  const { data: profileRow } = await sb.from('profiles').select('coins').eq('id', user.id).maybeSingle();

  // Referral stats (warehouse-based, as referrer)
  const { data: whData } = await sb.from('warehouses').select('code').eq('id', warehouseId).maybeSingle();
  let referral_stats = { total: 0, awarded: 0 };
  if (whData?.code) {
    const { data: myRefs } = await sb.from('referrals').select('status').eq('referrer_code', whData.code);
    referral_stats.total   = myRefs?.length ?? 0;
    referral_stats.awarded = myRefs?.filter(r => r.status === 'awarded').length ?? 0;
  }

  // Active campaign
  const today = new Date().toISOString().slice(0, 10);
  const { data: activeCamps } = await sb.from('referral_campaigns')
    .select('id, name, start_date, end_date, max_referrals_per_warehouse, referrer_credits, referee_credits')
    .eq('active', true).lte('start_date', today).gte('end_date', today).limit(1);
  const active_campaign = activeCamps?.[0] || null;

  // Notifications (still warehouse-based)
  const { data: notifRows } = await sb.from('notifications')
    .select('id, title, body, type, read, created_at')
    .eq('warehouse_id', warehouseId).order('created_at', { ascending: false }).limit(10);
  const unreadIds = (notifRows || []).filter(n => !n.read).map(n => n.id);
  const new_notifications = unreadIds.length;
  if (unreadIds.length) {
    await sb.from('notifications').update({ read: true }).in('id', unreadIds);
  }

  // Transaction history from unified tables
  const { data: walletTxs } = await sb.from('wallet_transactions')
    .select('amount_cents,description,created_at')
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
  const { data: creditTxs } = await sb.from('coins_transactions')
    .select('amount,description,created_at')
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);

  res.json({
    wallet_cents: walletRow?.balance_cents ?? 0,
    credits: profileRow?.coins ?? 0,
    referral_stats,
    active_campaign,
    notifications: notifRows || [],
    new_notifications,
    wallet_transactions: (walletTxs || []).map(t => ({ ...t, type: t.amount_cents >= 0 ? 'topup' : 'deduction' })),
    credit_transactions: (creditTxs || []).map(t => ({ ...t, type: t.amount >= 0 ? 'earn' : 'spend' })),
  });
};
