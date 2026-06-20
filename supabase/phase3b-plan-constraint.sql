-- ============================================================
-- ATMM.store Phase 3b — 放宽 subscriptions.plan 约束
-- 在 App 连接的 Supabase 项目（vkwndhdqbmuyogieccph）SQL Editor 跑一次。
-- 原约束只允许 trial/basic/standard/premium；新增 ztk / full3 / full4 / full5 / full13
-- 直接去掉该 check，让 plan 可存任意套餐标识（业务权限由 modules 字段决定）。
-- ============================================================

alter table subscriptions drop constraint if exists subscriptions_plan_check;

notify pgrst, 'reload schema';
