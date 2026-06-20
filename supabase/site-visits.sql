-- ============================================================
-- ATMM.store 访问流量统计表
-- 在 App 连接的 Supabase 项目（vkwndhdqbmuyogieccph）SQL Editor 跑一次。
-- 页面每会话写一条；管理后台用 service role 读取统计（访客读不到）。
-- ============================================================

create table if not exists site_visits (
  id          bigint generated always as identity primary key,
  path        text,
  ref         text,
  ua          text,
  created_at  timestamptz default now()
);
create index if not exists idx_site_visits_created on site_visits(created_at desc);

alter table site_visits enable row level security;

-- 允许任何人（匿名 + 已登录）写入一条访问；不开放读取
drop policy if exists "anyone insert site_visit" on site_visits;
create policy "anyone insert site_visit" on site_visits for insert to anon, authenticated with check (true);

notify pgrst, 'reload schema';
