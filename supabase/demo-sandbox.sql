-- ============================================================
-- ATMM.store 方法B：体验沙盒记录表（设备限制 + 累计计数 + 清理）
-- 在 App 连接的 Supabase 项目（vkwndhdqbmuyogieccph）SQL Editor 跑一次。
-- 仅服务端 API(service role) 访问，不开放普通角色。
-- ============================================================

create table if not exists atmm_demo (
  id           bigint generated always as identity primary key,  -- 体验账号编号 = 10000 + id
  device_id    text,                 -- 浏览器本地设备标识
  email        text,                 -- trialNNNNN@atmm.store
  user_id      uuid,
  warehouse_id uuid,
  created_at   timestamptz default now()
);
create index if not exists idx_atmm_demo_device  on atmm_demo(device_id, created_at desc);
create index if not exists idx_atmm_demo_created on atmm_demo(created_at);

alter table atmm_demo enable row level security;
-- 不加任何 policy：普通/匿名角色无法读写；只有 service role(API) 能操作。

notify pgrst, 'reload schema';
