const { createClient } = require('@supabase/supabase-js');

const PLATFORM_FEE_PCT = 15; // 15% platform cut

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Auth — optional for public GET routes
  let user = null;
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) {
    const { data } = await sb.auth.getUser(token);
    user = data?.user || null;
  }

  async function isBoss(whId) {
    if (!user || !whId) return false;
    const { data } = await sb.from('warehouse_members')
      .select('role').eq('warehouse_id', whId).eq('user_id', user.id).single();
    return data?.role === 'boss';
  }

  async function creditWallet(whId, cents, desc) {
    const { data: w } = await sb.from('wallets').select('id,balance_cents').eq('warehouse_id', whId).maybeSingle();
    if (w?.id) {
      await sb.from('wallets').update({ balance_cents: w.balance_cents + cents, updated_at: new Date().toISOString() }).eq('id', w.id);
    } else {
      await sb.from('wallets').insert({ warehouse_id: whId, balance_cents: cents });
    }
    await sb.from('warehouse_transactions').insert({ warehouse_id: whId, type: 'topup', amount_cents: cents, description: desc });
  }

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action, store_id, warehouse_id } = req.query;

    if (action === 'marketplace') {
      const { data: shops } = await sb.from('shops')
        .select('id, name, description, logo_url, created_at')
        .eq('active', true).order('created_at', { ascending: false }).limit(50);
      return res.json({ shops: shops || [] });
    }

    if (action === 'store' && store_id) {
      const { data: shop } = await sb.from('shops')
        .select('id, name, description, logo_url, default_l1_pct, default_l2_pct')
        .eq('id', store_id).eq('active', true).maybeSingle();
      if (!shop) return res.status(404).json({ error: 'Not found' });
      const { data: products } = await sb.from('shop_products')
        .select('id, name, description, image_url, price_cents, unit, stock, referral_enabled, commission_l1_pct, commission_l2_pct')
        .eq('shop_id', store_id).eq('active', true).order('created_at', { ascending: false });
      return res.json({ shop, products: products || [] });
    }

    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'my_store' && warehouse_id) {
      if (!await isBoss(warehouse_id)) return res.status(403).json({ error: 'Forbidden' });
      const { data: shop } = await sb.from('shops').select('*').eq('owner_warehouse_id', warehouse_id).maybeSingle();
      if (!shop) return res.json({ shop: null, products: [], orders: [] });
      const [{ data: products }, { data: orders }] = await Promise.all([
        sb.from('shop_products').select('*').eq('shop_id', shop.id).order('created_at', { ascending: false }),
        sb.from('shop_orders').select('*').eq('shop_id', shop.id).order('created_at', { ascending: false }).limit(50),
      ]);
      return res.json({ shop, products: products || [], orders: orders || [] });
    }

    return res.status(400).json({ error: 'Bad request' });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).end();
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { action, warehouseId } = req.body || {};

  // Create store
  if (action === 'create_store') {
    if (!warehouseId || !await isBoss(warehouseId)) return res.status(403).json({ error: 'Forbidden' });
    const { name, description, logo_url, default_l1_pct = 5, default_l2_pct = 2 } = req.body;
    if (!name) return res.status(400).json({ error: '请输入店铺名称' });
    const { data: ex } = await sb.from('shops').select('id').eq('owner_warehouse_id', warehouseId).maybeSingle();
    if (ex) return res.status(400).json({ error: '您已有店铺' });
    const { data: shop, error } = await sb.from('shops')
      .insert({ owner_warehouse_id: warehouseId, name, description: description || null, logo_url: logo_url || null, default_l1_pct, default_l2_pct })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, shop });
  }

  // Update store
  if (action === 'update_store') {
    if (!warehouseId || !await isBoss(warehouseId)) return res.status(403).json({ error: 'Forbidden' });
    const { name, description, logo_url, default_l1_pct, default_l2_pct, active } = req.body;
    const up = {};
    if (name !== undefined) up.name = name;
    if (description !== undefined) up.description = description;
    if (logo_url !== undefined) up.logo_url = logo_url;
    if (default_l1_pct !== undefined) up.default_l1_pct = default_l1_pct;
    if (default_l2_pct !== undefined) up.default_l2_pct = default_l2_pct;
    if (active !== undefined) up.active = active;
    await sb.from('shops').update(up).eq('owner_warehouse_id', warehouseId);
    return res.json({ ok: true });
  }

  // Create product
  if (action === 'create_product') {
    if (!warehouseId || !await isBoss(warehouseId)) return res.status(403).json({ error: 'Forbidden' });
    const { store_id, name, description, image_url, price_cents, unit = '件', stock, referral_enabled = true, commission_l1_pct, commission_l2_pct } = req.body;
    if (!store_id || !name || !price_cents) return res.status(400).json({ error: '缺少必填字段' });
    const { data: shop } = await sb.from('shops').select('id,default_l1_pct,default_l2_pct').eq('id', store_id).eq('owner_warehouse_id', warehouseId).maybeSingle();
    if (!shop) return res.status(403).json({ error: 'Forbidden' });
    const { data: product, error } = await sb.from('shop_products').insert({
      shop_id: store_id, name, description: description || null, image_url: image_url || null,
      price_cents, unit, stock: stock ?? null, referral_enabled,
      commission_l1_pct: commission_l1_pct ?? shop.default_l1_pct,
      commission_l2_pct: commission_l2_pct ?? shop.default_l2_pct,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, product });
  }

  // Update product
  if (action === 'update_product') {
    if (!warehouseId || !await isBoss(warehouseId)) return res.status(403).json({ error: 'Forbidden' });
    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Missing product_id' });
    const { data: p } = await sb.from('shop_products').select('id,shops(owner_warehouse_id)').eq('id', product_id).maybeSingle();
    if (!p || p.shops?.owner_warehouse_id !== warehouseId) return res.status(403).json({ error: 'Forbidden' });
    const allowed = ['name','description','image_url','price_cents','unit','stock','referral_enabled','commission_l1_pct','commission_l2_pct','active'];
    const up = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    await sb.from('shop_products').update(up).eq('id', product_id);
    return res.json({ ok: true });
  }

  // Delete product
  if (action === 'delete_product') {
    if (!warehouseId || !await isBoss(warehouseId)) return res.status(403).json({ error: 'Forbidden' });
    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Missing product_id' });
    const { count } = await sb.from('shop_orders').select('id', { count: 'exact' }).eq('product_id', product_id);
    if ((count || 0) > 0) {
      await sb.from('shop_products').update({ active: false }).eq('id', product_id);
    } else {
      await sb.from('shop_products').delete().eq('id', product_id);
    }
    return res.json({ ok: true });
  }

  // Record share (generate ref link)
  if (action === 'record_share') {
    const { product_id, parent_ref_code, sharer_wh_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Missing product_id' });
    const ref_code = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const { data: share, error } = await sb.from('shop_shares').insert({
      product_id,
      sharer_wh_id: sharer_wh_id || null,
      parent_ref_code: parent_ref_code || null,
      ref_code,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, ref_code: share.ref_code });
  }

  // Buy product
  if (action === 'buy') {
    const { product_id, quantity = 1, ref_code, buyer_name, notes } = req.body;
    if (!warehouseId || !product_id) return res.status(400).json({ error: 'Missing fields' });

    const { data: bm } = await sb.from('warehouse_members').select('role').eq('warehouse_id', warehouseId).eq('user_id', user.id).single();
    if (!bm) return res.status(403).json({ error: 'Forbidden' });

    const { data: product } = await sb.from('shop_products')
      .select('*, shops(id, owner_warehouse_id, default_l1_pct, default_l2_pct)')
      .eq('id', product_id).eq('active', true).maybeSingle();
    if (!product) return res.status(404).json({ error: '商品不存在' });
    if (product.shops?.owner_warehouse_id === warehouseId) return res.status(400).json({ error: '不能购买自己店铺的商品' });
    if (product.stock !== null && product.stock < quantity) return res.status(400).json({ error: '库存不足' });

    const qty = parseInt(quantity, 10) || 1;
    const total_cents = product.price_cents * qty;
    const platform_fee_cents = Math.round(total_cents * PLATFORM_FEE_PCT / 100);

    // Trace referral chain (max 2 levels)
    let l1_wh = null, l1_cents = 0, l2_wh = null, l2_cents = 0;
    if (ref_code && product.referral_enabled) {
      const { data: share } = await sb.from('shop_shares').select('sharer_wh_id, parent_ref_code').eq('ref_code', ref_code).maybeSingle();
      if (share?.sharer_wh_id && share.sharer_wh_id !== warehouseId) {
        l1_wh = share.sharer_wh_id;
        l1_cents = Math.round(total_cents * (product.commission_l1_pct / 100));
        if (share.parent_ref_code) {
          const { data: ps } = await sb.from('shop_shares').select('sharer_wh_id').eq('ref_code', share.parent_ref_code).maybeSingle();
          if (ps?.sharer_wh_id && ps.sharer_wh_id !== warehouseId && ps.sharer_wh_id !== l1_wh) {
            l2_wh = ps.sharer_wh_id;
            l2_cents = Math.round(total_cents * (product.commission_l2_pct / 100));
          }
        }
      }
    }

    const seller_cents = total_cents - platform_fee_cents - l1_cents - l2_cents;

    // Deduct from buyer wallet
    const { data: bWallet } = await sb.from('wallets').select('id,balance_cents').eq('warehouse_id', warehouseId).maybeSingle();
    if (!bWallet || bWallet.balance_cents < total_cents) return res.status(400).json({ error: '钱包余额不足，请先充值' });
    await sb.from('wallets').update({ balance_cents: bWallet.balance_cents - total_cents, updated_at: new Date().toISOString() }).eq('id', bWallet.id);
    await sb.from('warehouse_transactions').insert({ warehouse_id: warehouseId, type: 'deduction', amount_cents: -total_cents, description: `购买: ${product.name} ×${qty}` });

    // Credit seller, L1 and L2
    const sellerWh = product.shops.owner_warehouse_id;
    await creditWallet(sellerWh, seller_cents, `出售: ${product.name} ×${qty}`);
    if (l1_wh && l1_cents > 0) await creditWallet(l1_wh, l1_cents, `一级推荐佣金: ${product.name}`);
    if (l2_wh && l2_cents > 0) await creditWallet(l2_wh, l2_cents, `二级推荐佣金: ${product.name}`);

    // Deduct stock
    if (product.stock !== null) {
      await sb.from('shop_products').update({ stock: product.stock - qty }).eq('id', product_id);
    }

    // Create order record
    const { data: order } = await sb.from('shop_orders').insert({
      shop_id: product.shops.id, product_id, product_name: product.name,
      buyer_warehouse_id: warehouseId, buyer_name: buyer_name || null,
      quantity: qty, unit_price_cents: product.price_cents, total_cents,
      platform_fee_cents, seller_cents,
      l1_sharer_wh_id: l1_wh, l1_commission_cents: l1_cents,
      l2_sharer_wh_id: l2_wh, l2_commission_cents: l2_cents,
      ref_code: ref_code || null, payment_method: 'wallet', status: 'paid',
      notes: notes || null,
    }).select().single();

    return res.json({ ok: true, order_id: order?.id });
  }

  // Update order status
  if (action === 'update_order') {
    const { order_id, status } = req.body;
    if (!order_id || !status) return res.status(400).json({ error: 'Missing fields' });
    if (!['paid','shipped','completed','refunded'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { data: o } = await sb.from('shop_orders').select('id,shops(owner_warehouse_id)').eq('id', order_id).maybeSingle();
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (!await isBoss(o.shops?.owner_warehouse_id)) return res.status(403).json({ error: 'Forbidden' });
    await sb.from('shop_orders').update({ status }).eq('id', order_id);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
