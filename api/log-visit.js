const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 记录一次访问：服务端读取 Vercel 地理头(国家/城市/地区) + UA；
// 若带登录 token 则记录邮箱/用户。匿名访客无邮箱，但有来源/国家/设备。
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = req.body || {};
    const h = req.headers || {};
    let email = null, user_id = null;
    const token = (h.authorization || '').replace('Bearer ', '');
    if (token) {
      try {
        const { data: { user } } = await sb.auth.getUser(token);
        if (user) { email = user.email || null; user_id = user.id; }
      } catch (e) { /* 无效 token 忽略 */ }
    }
    await sb.from('atmm_visits').insert({
      path:    (b.path || '').slice(0, 200),
      ref:     (b.ref || '').slice(0, 300),
      ua:      (h['user-agent'] || '').slice(0, 250),
      lang:    (b.lang || '').slice(0, 20),
      country: h['x-vercel-ip-country'] || null,
      city:    h['x-vercel-ip-city'] || null,
      region:  h['x-vercel-ip-country-region'] || null,
      email,
      user_id,
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
};
