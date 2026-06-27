-- ============================================================
-- ATMM.store 法A：共享「体验账号」一次性建好
-- 前置：先在 Supabase Dashboard → Authentication → Add user 建好
--       邮箱 trial@atmm.store，密码 Trial123456，勾选 Auto Confirm，
--       复制新用户 UID 填到下面 v_trial。
-- v_src 填一个有示例数据的源仓库 id（建议用 atom22628 的主仓库）。
-- 在 vkwndhdqbmuyogieccph 项目 SQL Editor 跑一次。
-- ============================================================

do $$
declare
  v_trial uuid := '<5077325d-ea95-47d1-b651-43dd97af9f9c>';   -- ← 替换为 trial@atmm.store 的 UID
  v_src   uuid := '<b3d5f647-dda4-4434-9283-8700f96e4682>';      -- ← 替换为克隆示例数据的源仓库 id
  v_demo  uuid;
begin
  -- 1) 建体验仓库（owner=trial）
  insert into warehouses (name, owner_id) values ('体验仓库 Demo', v_trial)
  returning id into v_demo;

  -- 2) trial 作为老板
  insert into warehouse_members (warehouse_id, user_id, role, display_name)
  values (v_demo, v_trial, 'boss', '体验账号')
  on conflict (warehouse_id, user_id) do nothing;

  -- 3) 订阅：全业务、1 人(禁止加成员防滥用)、永不过期
  insert into subscriptions (warehouse_id, plan, status, max_members, modules, current_period_end)
  values (v_demo, 'premium', 'active', 1, '["yijian","zhuanyun"]'::jsonb, '2099-12-31')
  on conflict (warehouse_id) do update
    set plan='premium', status='active', max_members=1,
        modules='["yijian","zhuanyun"]'::jsonb, current_period_end='2099-12-31';

  -- 4) 克隆库存示例数据到体验仓库
  insert into warehouse_state (warehouse_id, models, shelf_black_table, shelf_white_table, pallet_table, meta)
  select v_demo, models, shelf_black_table, shelf_white_table, pallet_table, meta
  from warehouse_state where warehouse_id = v_src
  on conflict (warehouse_id) do update
    set models=excluded.models, shelf_black_table=excluded.shelf_black_table,
        shelf_white_table=excluded.shelf_white_table, pallet_table=excluded.pallet_table, meta=excluded.meta;

  -- 5) 存库存快照，供每小时自动重置恢复
  insert into atmm_settings (warehouse_id, data)
  select v_demo, jsonb_build_object('demo_snapshot', jsonb_build_object(
    'models', models, 'shelf_black_table', shelf_black_table, 'shelf_white_table', shelf_white_table,
    'pallet_table', pallet_table, 'meta', meta))
  from warehouse_state where warehouse_id = v_demo
  on conflict (warehouse_id) do update set data = excluded.data;
end $$;

notify pgrst, 'reload schema';
