-- ============================================================
-- ATMM.store — 转运 / 快拆 / 一件代发出库 订单数据表（通用版）
-- 在 ATMM 的 Supabase 项目 SQL Editor 里跑一次即可。
-- 依赖：warehouses 表与 is_member() 函数（schema.sql 已建）。
-- 三业务共用同一套客户/订单/托板底座；business 字段区分。
-- ============================================================

-- 客户（客户号 C0001…C9999，仓库内唯一）
create table if not exists atmm_customers (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  customer_no  text not null,                       -- C0001
  name         text,                                -- 客户名称
  contact      text,                                -- 联系方式
  extra        jsonb default '{}'::jsonb,           -- 自定义字段（+）
  created_at   timestamptz default now(),
  unique (warehouse_id, customer_no)
);

-- 内部订单（快拆 / 转运 / 一件代发，仓库内唯一）
-- 单号前缀由前端按「老板自定义前缀」生成，这里不限制具体前缀。
create table if not exists atmm_orders (
  id              uuid primary key default gen_random_uuid(),
  warehouse_id    uuid not null references warehouses(id) on delete cascade,
  customer_id     uuid references atmm_customers(id) on delete set null,
  customer_no     text not null,                    -- 冗余存一份，方便标签/报表
  order_no        text not null,                    -- 如 TF0000001（前缀可由老板自定义）
  business        text not null default 'kuaicha'
                  check (business in ('kuaicha','zhuanyun','yijian')),
  bill_no         text,                             -- 提单号 / 发货单号
  waybills        jsonb default '[]'::jsonb,        -- [{waybill_no,pieces,volume,weight,remarks}]
  manifest        jsonb,                            -- 转运：上传的提货单/装箱单 {filename,headers,rows}
  free_days       int default 3,                    -- 转运：免费存放天数
  order_at        timestamptz default now(),        -- 步3：日期时间（可改）
  location_code   text default 'K',                 -- 步5：库位（快拆默认 K）
  pallet_count    int not null default 0,           -- 步4：托/板数量
  status          text not null default 'created'
                  check (status in ('created','inbound','shipped')),
  extra           jsonb default '{}'::jsonb,        -- 自定义字段（+）；含 doc_type 等
  inbound_done_at  timestamptz,                     -- 全部入库完成时间
  outbound_done_at timestamptz,                     -- 全部出库完成时间
  created_at      timestamptz default now(),
  unique (warehouse_id, order_no)
);

-- 每个托/板（一个订单 N 个，逐托扫码进出库 + 拍照存档）
create table if not exists atmm_pallets (
  id             uuid primary key default gen_random_uuid(),
  warehouse_id   uuid not null references warehouses(id) on delete cascade,
  order_id       uuid not null references atmm_orders(id) on delete cascade,
  seq            int not null,                      -- 顺序号 1..N
  label          text,                              -- 标签三/四行文字
  qr_text        text,                              -- 扫码内容（唯一标识此托）
  location_code  text default 'K',
  group_label    text,                              -- 分类（目的地/承运商，如 FedEx / UPS）
  inbound_at     timestamptz,                       -- 入库扫码时间
  outbound_at    timestamptz,                       -- 出库扫码时间
  inbound_photo  text,                              -- 入库拍照存档（Storage 路径/URL）
  outbound_photo text,                              -- 出库拍照存档（Storage 路径/URL）
  unique (order_id, seq)
);

create index if not exists idx_atmm_orders_wh     on atmm_orders(warehouse_id);
create index if not exists idx_atmm_orders_biz    on atmm_orders(warehouse_id, business);
create index if not exists idx_atmm_pallets_order on atmm_pallets(order_id);
create index if not exists idx_atmm_customers_wh  on atmm_customers(warehouse_id);

-- ============================================================
-- Row Level Security：仓库成员可读写（小团队，操作员也要扫码进出库）
-- ============================================================
alter table atmm_customers enable row level security;
alter table atmm_orders    enable row level security;
alter table atmm_pallets   enable row level security;

drop policy if exists "members rw atmm_customers" on atmm_customers;
drop policy if exists "members rw atmm_orders"    on atmm_orders;
drop policy if exists "members rw atmm_pallets"   on atmm_pallets;

create policy "members rw atmm_customers" on atmm_customers for all
  using (is_member(auth.uid(), warehouse_id)) with check (is_member(auth.uid(), warehouse_id));
create policy "members rw atmm_orders" on atmm_orders for all
  using (is_member(auth.uid(), warehouse_id)) with check (is_member(auth.uid(), warehouse_id));
create policy "members rw atmm_pallets" on atmm_pallets for all
  using (is_member(auth.uid(), warehouse_id)) with check (is_member(auth.uid(), warehouse_id));

-- ============================================================
-- 每仓库通用设置（单号前缀、免费存放天数、打印抬头 Logo 等）
-- 单行 jsonb，便于以后扩展，不用频繁 ALTER。
-- ============================================================
create table if not exists atmm_settings (
  warehouse_id uuid primary key references warehouses(id) on delete cascade,
  data         jsonb not null default '{}'::jsonb,   -- {prefixes:{zhuanyun_in,zhuanyun_pick,kuaicha}, free_days, logo_url, ...}
  updated_at   timestamptz default now()
);

alter table atmm_settings enable row level security;
drop policy if exists "members rw atmm_settings" on atmm_settings;
create policy "members rw atmm_settings" on atmm_settings for all
  using (is_member(auth.uid(), warehouse_id)) with check (is_member(auth.uid(), warehouse_id));

-- ============================================================
-- 托/板 入出库拍照存档 Storage 桶（公开读，图片作业凭证）
-- ============================================================
insert into storage.buckets (id, name, public)
values ('pallet-photos', 'pallet-photos', true)
on conflict (id) do nothing;

drop policy if exists "pallet photos upload" on storage.objects;
drop policy if exists "pallet photos update" on storage.objects;
drop policy if exists "pallet photos read"   on storage.objects;

create policy "pallet photos upload" on storage.objects for insert
  to authenticated with check (bucket_id = 'pallet-photos');
create policy "pallet photos update" on storage.objects for update
  to authenticated using (bucket_id = 'pallet-photos');
create policy "pallet photos read" on storage.objects for select
  using (bucket_id = 'pallet-photos');
