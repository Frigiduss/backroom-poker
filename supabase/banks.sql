-- Back Room Poker: limits on chip banks saved online.
-- Run this once, after setup.sql, admin.sql and leaderboard.sql, in the SQL Editor
-- (New query → paste → Run). Running it again is safe.
--
-- Games against bots run in the browser, so the database can't see their hands. What it can
-- do is refuse a bank that grows faster than real play allows. Every save of a player goes
-- through guard_player(), which keeps a "win allowance" per account in bank_guard:
--   * losing chips always saves, and gives the allowance back, so ups and downs cost nothing
--   * winning chips spends the allowance; it refills by 2,000 chips a minute up to 500,000,
--     and a new account starts with 100,000
--   * a win bigger than the allowance saves only what the allowance covers. The browser keeps
--     sending its own number, so an honest big win still arrives as the allowance refills
--   * a refill (bank under 1,000 topped up to 10,000) is free once an hour
--   * a daily bonus collected through claim_daily_bonus() adds its chips to the allowance
--   * the biggest pot can't jump past 50,000 (a full table of 200-big-blind stacks is 36,000)
-- Admins (console edits) and the server's own key aren't limited. Editing a saved player in
-- the browser can therefore only ever add as much as real winning could.

create table if not exists public.bank_guard (
  owner uuid primary key references auth.users (id) on delete cascade,
  allowance numeric not null,
  at timestamptz not null default now(),
  last_refill timestamptz not null default '-infinity',
  clamped bigint not null default 0
);

alter table public.bank_guard enable row level security;
revoke all on public.bank_guard from anon, authenticated;
-- No policies: only the functions below (and admins in the SQL Editor) touch it.

-- The allowance now: what was left, plus 2,000 a minute since, up to 500,000 (more is kept if
-- it came from losses or a bonus).
create or replace function public.bank_allowance(g public.bank_guard)
returns numeric
language sql
stable
set search_path = ''
as $$
  select greatest(g.allowance, least(500000, g.allowance + floor(extract(epoch from (now() - g.at)) / 60 * 2000)));
$$;

create or replace function public.guard_player()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.bank_guard%rowtype;
  allow numeric;
  before_bank numeric := case when tg_op = 'UPDATE' then public.lb_num(old.data -> 'bank') else 10000 end;
  after_bank numeric := greatest(0, floor(public.lb_num(new.data -> 'bank')));
  delta numeric;
  before_pot numeric := case when tg_op = 'UPDATE' then public.lb_num(old.data #> '{stats,biggestPot}') else 0 end;
  capped boolean := false;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or public.is_admin() then
    return new;
  end if;
  insert into public.bank_guard (owner, allowance) values (new.owner, 100000) on conflict do nothing;
  select * into g from public.bank_guard where owner = new.owner for update;
  allow := public.bank_allowance(g);
  delta := after_bank - before_bank;

  if delta > 0 and before_bank < 1000 and after_bank = 10000 and g.last_refill < now() - interval '1 hour'
      and coalesce(jsonb_typeof(new.data -> 'table'), 'null') = 'null' then
    g.last_refill := now();
    delta := 0;
  end if;

  if delta <= 0 then
    -- A new player starting low gives nothing back, or deleting and re-adding one would mint allowance.
    if tg_op = 'UPDATE' then allow := allow - delta; end if;
  elsif delta <= allow then
    allow := allow - delta;
  else
    after_bank := before_bank + floor(allow);
    allow := 0;
    capped := true;
  end if;
  new.data := jsonb_set(new.data, '{bank}', to_jsonb(after_bank));

  if public.lb_num(new.data #> '{stats,biggestPot}') > greatest(before_pot, 50000) then
    new.data := jsonb_set(new.data, '{stats,biggestPot}', to_jsonb(greatest(before_pot, 50000)));
    capped := true;
  end if;

  update public.bank_guard
  set allowance = allow, at = now(), last_refill = g.last_refill, clamped = g.clamped + (case when capped then 1 else 0 end)
  where owner = new.owner;
  return new;
end;
$$;

revoke all on function public.guard_player() from public, anon, authenticated;

drop trigger if exists guard_player on public.players;
create trigger guard_player before insert or update on public.players
  for each row execute function public.guard_player();

-- A collected daily bonus adds its chips to the allowance, so saving them never runs into it.
create or replace function public.guard_bonus()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.last_claim is distinct from old.last_claim then
    insert into public.bank_guard (owner, allowance) values (new.owner, 100000) on conflict do nothing;
    update public.bank_guard
    set allowance = public.bank_allowance(bank_guard) + 1000 + 500 * (least(new.streak, 7) - 1), at = now()
    where owner = new.owner;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_bonus() from public, anon, authenticated;

do $$ begin
  if to_regclass('public.daily_bonus') is not null then
    drop trigger if exists guard_bonus on public.daily_bonus;
    create trigger guard_bonus after update on public.daily_bonus
      for each row execute function public.guard_bonus();
  end if;
end $$;
