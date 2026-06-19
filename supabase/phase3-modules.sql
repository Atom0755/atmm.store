-- ============================================================
-- ATMM.store Phase 3 — 订阅按「业务模块」开通
-- 在 App 连接的 Supabase 项目（vkwndhdqbmuyogieccph）SQL Editor 跑一次。
-- ============================================================

-- 1) 订阅表加 modules 字段：该仓库已开通哪些业务模块
--    默认仅「一件代发」；含转运快拆的套餐开通后写入 ["yijian","zhuanyun"]
alter table subscriptions
  add column if not exists modules jsonb not null default '["yijian"]'::jsonb;

-- 2) demo 授权：给你自己的仓库开通转运+快拆（用于演示）
--    简单做法（早期只有自己用）：给所有仓库开通。以后正式按订阅管理。
update subscriptions set modules = '["yijian","zhuanyun"]'::jsonb;

-- 刷新 API schema 缓存
notify pgrst, 'reload schema';

-- 验证：看各仓库已开通模块
select warehouse_id, plan, max_members, modules from subscriptions;
