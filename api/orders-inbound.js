const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 通用订单接入：客户系统用 API 密钥把订单 POST 过来，自动建一件代发出库单。
// 出库拣货页的「出库单记录」即可看到并打印拣货表（库位/重量/体积打印时按当前货架计算）。
// 请求头：x-api-key: <仓库的订单接入密钥>
// 请求体：{ customer_no?, customer_name?, contact?, order_no?, items:[{ sku|name, qty, unit? }] }
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const apiKey = (req.headers['x-api-key'] || '').trim();
    if (!apiKey) return res.status(401).json({ error: '缺少 x-api-key' });

    // 按密钥找仓库
    const { data: setting } = await sb.from('atmm_settings')
      .select('warehouse_id,data').eq('data->>api_key', apiKey).maybeSingle();
    if (!setting?.warehouse_id) return res.status(401).json({ error: '无效的 API 密钥' });
    const whId = setting.warehouse_id;

    const body = req.body || {};
    const itemsIn = Array.isArray(body.items) ? body.items : [];
    if (!itemsIn.length) return res.status(400).json({ error: 'items 不能为空' });
    const items = itemsIn.map(it => ({
      name: String(it.sku || it.name || '').trim(),
      qty: parseInt(it.qty, 10) || 1,
      unit: (it.unit || '箱').toString().trim(),
    })).filter(it => it.name);
    if (!items.length) return res.status(400).json({ error: 'items 缺少 sku/name' });

    // 客户号：给了就用，没给自动 C+4
    let customerNo = (body.customer_no || '').trim().toUpperCase();
    if (!customerNo) {
      const { data: c } = await sb.from('atmm_customers').select('customer_no')
        .eq('warehouse_id', whId).like('customer_no', 'C%').order('customer_no', { ascending: false }).limit(1);
      let n = 1; if (c && c[0]) { const m = /^C(\d+)$/.exec(c[0].customer_no); if (m) n = parseInt(m[1]) + 1; }
      customerNo = 'C' + String(n).padStart(4, '0');
    }
    const custName = (body.customer_name || '').trim();
    const contact = (body.contact || '').trim();
    let customerId = null;
    const { data: ex } = await sb.from('atmm_customers').select('id')
      .eq('warehouse_id', whId).eq('customer_no', customerNo).maybeSingle();
    if (ex) { customerId = ex.id; if (custName || contact) await sb.from('atmm_customers').update({ name: custName, contact }).eq('id', ex.id); }
    else { const { data: ins } = await sb.from('atmm_customers').insert({ warehouse_id: whId, customer_no: customerNo, name: custName, contact }).select('id').single(); customerId = ins?.id; }

    // 出库单号：给了就用，没给自动 前缀+7位（前缀取设置，默认 DF）
    let orderNo = (body.order_no || '').trim();
    if (!orderNo) {
      const pfx = (setting.data && setting.data.prefixes && setting.data.prefixes.yijian) || 'DF';
      const { data: o } = await sb.from('atmm_orders').select('order_no')
        .eq('warehouse_id', whId).eq('business', 'yijian').like('order_no', pfx + '%')
        .order('order_no', { ascending: false }).limit(1);
      let n = 1; if (o && o[0]) { const m = new RegExp('^' + pfx + '(\\d+)$').exec(o[0].order_no); if (m) n = parseInt(m[1]) + 1; }
      orderNo = pfx + String(n).padStart(7, '0');
    }

    const { data: ord, error: oErr } = await sb.from('atmm_orders').insert({
      warehouse_id: whId, customer_id: customerId, customer_no: customerNo, order_no: orderNo,
      business: 'yijian', status: 'created', pallet_count: items.length,
      extra: { items, customer_name: custName, contact, source: 'api' },
    }).select('order_no').single();
    if (oErr) {
      if (String(oErr.message || '').includes('duplicate')) return res.status(409).json({ error: '订单号已存在: ' + orderNo });
      throw oErr;
    }
    res.json({ ok: true, order_no: ord.order_no, customer_no: customerNo, items: items.length });
  } catch (e) {
    console.error('[orders-inbound] error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
