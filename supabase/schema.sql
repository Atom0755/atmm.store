-- ============================================================
-- ATMM.STORE Database Schema
-- Run in: ZEHEM.AI Supabase project (vkwndhdqbmuyogieccph)
-- Supabase Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- Auto-generate warehouse invite codes like ATOM-X7K2
create or replace function generate_warehouse_code()
returns text language plpgsql as $$
declare
  chars  text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  n      int;
begin
  loop
    v_code := 'ATOM-';
    for i in 1..4 loop
      v_code := v_code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    end loop;
    select count(*) into n from warehouses where warehouses.code = v_code;
    exit when n = 0;
  end loop;
  return v_code;
end;
$$;

-- Warehouses
create table if not exists warehouses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null default '我的仓库',
  code          text unique not null default generate_warehouse_code(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz default now(),
  trial_ends_at timestamptz default (now() + interval '30 days')
);

-- Members: boss / manager / operator
create table if not exists warehouse_members (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('boss','manager','operator')),
  display_name text,
  invited_by   uuid references auth.users(id),
  joined_at    timestamptz default now(),
  unique(warehouse_id, user_id)
);

-- Pending email invitations
create table if not exists invitations (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  email        text not null,
  role         text not null check (role in ('manager','operator')),
  token        text unique not null default encode(gen_random_bytes(16),'hex'),
  invited_by   uuid references auth.users(id),
  expires_at   timestamptz default (now() + interval '7 days'),
  accepted_at  timestamptz,
  created_at   timestamptz default now()
);

-- Subscriptions
create table if not exists subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  warehouse_id           uuid not null unique references warehouses(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  plan                   text not null default 'trial'
                         check (plan in ('trial','basic','standard','premium')),
  billing_cycle          text check (billing_cycle in ('monthly','annual')),
  status                 text not null default 'active'
                         check (status in ('active','past_due','canceled','expired')),
  max_members            int not null default 1,
  current_period_end     timestamptz,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- Inventory state (JSON blobs — mirrors localStorage structure exactly)
create table if not exists warehouse_state (
  id                uuid primary key default gen_random_uuid(),
  warehouse_id      uuid not null unique references warehouses(id) on delete cascade,
  models            jsonb default '[]'::jsonb,
  shelf_black_table jsonb default '{}'::jsonb,
  shelf_white_table jsonb default '{}'::jsonb,
  pallet_table      jsonb default '{}'::jsonb,
  meta              jsonb default '{}'::jsonb,
  updated_at        timestamptz default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table warehouses        enable row level security;
alter table warehouse_members enable row level security;
alter table invitations        enable row level security;
alter table subscriptions     enable row level security;
alter table warehouse_state   enable row level security;

-- Helper: is user a member of a warehouse?
create or replace function is_member(uid uuid, wid uuid)
returns boolean language sql security definer as $$
  select exists(select 1 from warehouse_members where user_id=uid and warehouse_id=wid)
$$;

-- Helper: what role does user have in a warehouse?
create or replace function member_role(uid uuid, wid uuid)
returns text language sql security definer as $$
  select role from warehouse_members where user_id=uid and warehouse_id=wid limit 1
$$;

-- warehouses
create policy "view own warehouse"   on warehouses for select using (is_member(auth.uid(), id));
create policy "owner updates"        on warehouses for update using (owner_id = auth.uid());
create policy "owner creates"        on warehouses for insert with check (owner_id = auth.uid());

-- warehouse_members
create policy "members see team"     on warehouse_members for select using (is_member(auth.uid(), warehouse_id));
create policy "boss manages team"    on warehouse_members for all    using (member_role(auth.uid(), warehouse_id) = 'boss');
create policy "self-join via invite" on warehouse_members for insert with check (user_id = auth.uid());

-- invitations
create policy "boss manages invites" on invitations for all    using (member_role(auth.uid(), warehouse_id) = 'boss');
create policy "invitee reads own"    on invitations for select using (email = (select email from auth.users where id = auth.uid()));

-- subscriptions
create policy "members view sub"     on subscriptions for select using (is_member(auth.uid(), warehouse_id));

-- warehouse_state
create policy "members read state"         on warehouse_state for select using (is_member(auth.uid(), warehouse_id));
create policy "boss+manager write state"   on warehouse_state for all    using (member_role(auth.uid(), warehouse_id) in ('boss','manager'));
create policy "operator updates state"     on warehouse_state for update using (member_role(auth.uid(), warehouse_id) = 'operator');

-- ============================================================
-- Triggers: auto-setup when warehouse is created
-- ============================================================

create or replace function on_warehouse_created()
returns trigger language plpgsql security definer as $$
begin
  -- Add owner as boss
  insert into warehouse_members (warehouse_id, user_id, role, display_name)
  values (new.id, new.owner_id, 'boss',
    (select email from auth.users where id = new.owner_id));

  -- Create 30-day trial subscription
  insert into subscriptions (warehouse_id, plan, status, max_members, current_period_end)
  values (new.id, 'trial', 'active', 1, new.trial_ends_at);

  -- Create empty inventory state record
  insert into warehouse_state (warehouse_id) values (new.id);

  return new;
end;
$$;

create trigger trg_warehouse_created
  after insert on warehouses
  for each row execute function on_warehouse_created();

-- ============================================================
-- Wallet & Credits tables (add-on — run separately if missing)
-- ============================================================

-- Wallet balance per warehouse (USD cents)
create table if not exists wallets (
  id            uuid primary key default gen_random_uuid(),
  warehouse_id  uuid not null unique references warehouses(id) on delete cascade,
  balance_cents bigint not null default 0,
  updated_at    timestamptz default now()
);

-- Wallet transaction ledger (topup / deduction / refund)
create table if not exists warehouse_transactions (
  id                        uuid primary key default gen_random_uuid(),
  warehouse_id              uuid not null references warehouses(id) on delete cascade,
  type                      text not null check (type in ('topup','deduction','refund')),
  amount_cents              bigint not null,
  description               text,
  stripe_payment_intent_id  text unique,
  created_at                timestamptz default now()
);

-- Credits balance per warehouse (integer credits)
create table if not exists credits (
  id            uuid primary key default gen_random_uuid(),
  warehouse_id  uuid not null unique references warehouses(id) on delete cascade,
  balance       bigint not null default 0,
  updated_at    timestamptz default now()
);

-- Credits transaction ledger
create table if not exists warehouse_credit_transactions (
  id            uuid primary key default gen_random_uuid(),
  warehouse_id  uuid not null references warehouses(id) on delete cascade,
  type          text not null check (type in ('purchase','usage','refund')),
  amount        bigint not null,
  description   text,
  created_at    timestamptz default now()
);

-- RLS
alter table wallets                      enable row level security;
alter table warehouse_transactions       enable row level security;
alter table credits                      enable row level security;
alter table warehouse_credit_transactions enable row level security;

-- Wallets: members can read; service role writes (bypass RLS in API)
create policy "members view wallet"  on wallets                      for select using (is_member(auth.uid(), warehouse_id));
create policy "members view txns"    on warehouse_transactions       for select using (is_member(auth.uid(), warehouse_id));
create policy "members view credits" on credits                      for select using (is_member(auth.uid(), warehouse_id));
create policy "members view cr_txns" on warehouse_credit_transactions for select using (is_member(auth.uid(), warehouse_id));
