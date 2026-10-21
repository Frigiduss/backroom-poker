-- Back Room Poker: online accounts.
-- Run this once in your Supabase project (SQL Editor → New query → paste → Run).
-- Each row is one player. Row level security means a signed-in account can only
-- see and change its own players.

create table if not exists public.players (
  id text primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists players_owner_idx on public.players (owner);

alter table public.players enable row level security;

drop policy if exists "Players: owner can read" on public.players;
drop policy if exists "Players: owner can add" on public.players;
drop policy if exists "Players: owner can change" on public.players;
drop policy if exists "Players: owner can delete" on public.players;

create policy "Players: owner can read" on public.players
  for select to authenticated using (owner = auth.uid());
create policy "Players: owner can add" on public.players
  for insert to authenticated with check (owner = auth.uid());
create policy "Players: owner can change" on public.players
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "Players: owner can delete" on public.players
  for delete to authenticated using (owner = auth.uid());

grant select, insert, update, delete on public.players to authenticated;

-- True unless the signed-in account has an authenticator app and this sign-in skipped its code.
-- Restrictive policies use it, so a stolen password alone can't read or change anything.
create or replace function public.mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$$;

revoke all on function public.mfa_ok() from public;
grant execute on function public.mfa_ok() to anon, authenticated;

drop policy if exists "Players: two-step sign-in finished" on public.players;
create policy "Players: two-step sign-in finished" on public.players as restrictive
  for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));
