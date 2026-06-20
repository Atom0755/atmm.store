-- ============================================================
-- ATMM.store 访问流量统计表（独立表，避免与 ZEHEM 的 site_visits 混用）
-- 在 App 连接的 Supabase 项目（vkwndhdqbmuyogieccph）SQL Editor 跑一次。
-- 页面每会话写一条；管理后台用 service role 读取统计（访客读不到）。
-- ============================================================

create table if not exists atmm_visits (
  id          bigint generated always as identity primary key,
  path        text,
  ref         text,
  ua          text,
  created_at  timestamptz default now()
);
-- 来源/设备/登录邮箱等字段（已建过基础表的话，这些 ALTER 会补齐）
alter table atmm_visits add column if not exists lang    text;
alter table atmm_visits add column if not exists country text;
alter table atmm_visits add column if not exists city    text;
alter table atmm_visits add column if not exists region  text;
alter table atmm_visits add column if not exists email   text;
alter table atmm_visits add column if not exists user_id uuid;

create index if not exists idx_atmm_visits_created on atmm_visits(created_at desc);

alter table atmm_visits enable row level security;

-- 允许任何人（匿名 + 已登录）写入一条访问；不开放读取
drop policy if exists "anyone insert atmm_visit" on atmm_visits;
create policy "anyone insert atmm_visit" on atmm_visits for insert to anon, authenticated with check (true);

notify pgrst, 'reload schema';
