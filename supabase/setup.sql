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
