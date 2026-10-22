-- Back Room Poker: achievements earned at online tables.
-- Run this once, after multiplayer.sql and setup.sql (or security.sql on an older project),
-- in the SQL Editor (New query → paste → Run).
-- Running it again is safe.
--
-- Achievements from games against bots are kept with each player. Achievements from online
-- tables are counted by the poker-table function instead, here, where a browser can read its
-- own rows but never write them. That way nobody can award themselves an online achievement.

create table if not exists public.player_awards (
  owner uuid not null references auth.users (id) on delete cascade,
  player_id text not null,
  counters jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner, player_id)
);

alter table public.player_awards enable row level security;
revoke all on public.player_awards from anon, authenticated;
grant select on public.player_awards to authenticated;

drop policy if exists "Player awards: read your own" on public.player_awards;
create policy "Player awards: read your own" on public.player_awards
  for select to authenticated using (owner = auth.uid());
drop policy if exists "Player awards: two-step sign-in finished" on public.player_awards;
create policy "Player awards: two-step sign-in finished" on public.player_awards as restrictive
  for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));

-- Adds to players' counters: "sum" counters are added, "max" counters keep the larger value.
-- p_credits is a list of {owner, player_id, sum: {counter: n}, max: {counter: n}}.
-- Only the server calls it.
create or replace function public.credit_awards(p_credits jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c jsonb;
  cur jsonb;
  k text;
  v jsonb;
begin
  for c in select value from jsonb_array_elements(p_credits) loop
    insert into public.player_awards (owner, player_id)
    values ((c->>'owner')::uuid, c->>'player_id')
    on conflict do nothing;
    select counters into cur from public.player_awards
    where owner = (c->>'owner')::uuid and player_id = c->>'player_id'
    for update;
    for k, v in select key, value from jsonb_each(coalesce(c->'sum', '{}'::jsonb)) loop
      cur := jsonb_set(cur, array[k], to_jsonb(coalesce((cur->>k)::numeric, 0) + (v#>>'{}')::numeric));
    end loop;
    for k, v in select key, value from jsonb_each(coalesce(c->'max', '{}'::jsonb)) loop
      cur := jsonb_set(cur, array[k], to_jsonb(greatest(coalesce((cur->>k)::numeric, 0), (v#>>'{}')::numeric)));
    end loop;
    update public.player_awards set counters = cur, updated_at = now()
    where owner = (c->>'owner')::uuid and player_id = c->>'player_id';
  end loop;
end;
$$;

revoke all on function public.credit_awards(jsonb) from public, anon, authenticated;
grant execute on function public.credit_awards(jsonb) to service_role;
