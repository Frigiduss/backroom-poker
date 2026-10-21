-- Back Room Poker: online tables with friends.
-- Run this once, after setup.sql (or security.sql on an older project), in your Supabase project (SQL Editor → New query → paste → Run).
-- Safe to run again.
--
-- poker_tables holds each table's full state, including the deck and everyone's cards.
-- Nobody can read it from the browser: only the poker-table Edge Function (which runs on
-- Supabase with the service key) reads and writes it.
-- poker_views holds what each person at a table is allowed to see. Row security lets a
-- signed-in account read only its own rows, so nobody can peek at another player's cards.

create table if not exists public.poker_tables (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  version integer not null default 0,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.poker_tables enable row level security;
revoke all on public.poker_tables from anon, authenticated;

create table if not exists public.poker_views (
  table_id uuid not null references public.poker_tables (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null,
  view jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (table_id, user_id)
);

create index if not exists poker_views_user_idx on public.poker_views (user_id, updated_at desc);

alter table public.poker_views enable row level security;
revoke all on public.poker_views from anon, authenticated;
grant select on public.poker_views to authenticated;

drop policy if exists "Poker views: read your own" on public.poker_views;
create policy "Poker views: read your own" on public.poker_views
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Poker views: two-step sign-in finished" on public.poker_views;
create policy "Poker views: two-step sign-in finished" on public.poker_views as restrictive
  for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));

-- Writes views without ever replacing a newer one with an older one. Only the server calls it.
create or replace function public.put_poker_views(p_table uuid, p_views jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.poker_views (table_id, user_id, version, view, updated_at)
  select p_table, (v->>'user_id')::uuid, (v->>'version')::integer, v->'view', now()
  from jsonb_array_elements(p_views) as v
  on conflict (table_id, user_id) do update
    set version = excluded.version, view = excluded.view, updated_at = excluded.updated_at
    where poker_views.version < excluded.version;
$$;

revoke all on function public.put_poker_views(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.put_poker_views(uuid, jsonb) to service_role;
