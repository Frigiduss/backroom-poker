-- Back Room Poker: the daily chip bonus and the leaderboard.
-- Run this once, after setup.sql and admin.sql (or security.sql on an older project), in the SQL Editor (New query → paste → Run).
-- Running it again is safe, and needed after an update that changes it (faces on the leaderboard: 2026-11).
--
--   * daily_bonus          when each online player last collected the daily bonus. Browsers can
--                          read their own rows but never write them.
--   * claim_daily_bonus()  collects the bonus if it's due. The server's clock decides, so a
--                          changed device clock or edited save can't collect it twice.
--   * leaderboard()        the top players by chip bank, biggest pot or achievements. Anyone can
--                          read it; it returns names, colours, titles and scores, never emails.
--   * leaderboard_hidden   players an admin took off the leaderboard (console: edit <player> board off).

create table if not exists public.daily_bonus (
  owner uuid not null references auth.users (id) on delete cascade,
  player_id text not null,
  last_claim timestamptz not null,
  streak integer not null default 0,
  primary key (owner, player_id)
);

alter table public.daily_bonus enable row level security;
revoke all on public.daily_bonus from anon, authenticated;
grant select on public.daily_bonus to authenticated;
drop policy if exists "Daily bonus: read your own" on public.daily_bonus;
create policy "Daily bonus: read your own" on public.daily_bonus
  for select to authenticated using (owner = auth.uid());
drop policy if exists "Daily bonus: two-step sign-in finished" on public.daily_bonus;
create policy "Daily bonus: two-step sign-in finished" on public.daily_bonus as restrictive
  for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));

-- The numbers match src/accounts/bonus.ts: every 20 hours, the streak holds if claimed within
-- 48 hours, 1,000 chips on day one rising 500 a day to 4,000 from day seven.
-- Returns {amount, streak, last}: amount is 0 when it's too soon, and last is epoch milliseconds.
create or replace function public.claim_daily_bonus(p_player text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  b public.daily_bonus%rowtype;
  day integer;
begin
  if me is null then
    raise exception 'Sign in to collect the daily bonus.' using errcode = '42501';
  end if;
  if not public.mfa_ok() then
    raise exception 'Finish two-step sign-in first.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.players where id = p_player and owner = me) then
    raise exception 'That player isn''t in your account.' using errcode = '42501';
  end if;
  insert into public.daily_bonus (owner, player_id, last_claim, streak)
  values (me, p_player, '-infinity', 0)
  on conflict do nothing;
  select * into b from public.daily_bonus where owner = me and player_id = p_player for update;
  if b.last_claim > now() - interval '20 hours' then
    return jsonb_build_object('amount', 0, 'streak', b.streak, 'last', floor(extract(epoch from b.last_claim) * 1000));
  end if;
  day := case when b.last_claim >= now() - interval '48 hours' then b.streak + 1 else 1 end;
  update public.daily_bonus set last_claim = now(), streak = day where owner = me and player_id = p_player;
  return jsonb_build_object('amount', 1000 + 500 * (least(day, 7) - 1), 'streak', day, 'last', floor(extract(epoch from now()) * 1000));
end;
$$;

revoke all on function public.claim_daily_bonus(text) from public, anon;
grant execute on function public.claim_daily_bonus(text) to authenticated;

-- A number from a player's saved data, or 0 if it's missing or not a number.
create or replace function public.lb_num(j jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric else 0 end;
$$;

create table if not exists public.leaderboard_hidden (
  player_id text primary key,
  hidden_at timestamptz not null default now()
);

alter table public.leaderboard_hidden enable row level security;
revoke all on public.leaderboard_hidden from anon, authenticated;
grant select, insert, delete on public.leaderboard_hidden to authenticated;
drop policy if exists "Leaderboard hidden: admin can read" on public.leaderboard_hidden;
drop policy if exists "Leaderboard hidden: admin can add" on public.leaderboard_hidden;
drop policy if exists "Leaderboard hidden: admin can delete" on public.leaderboard_hidden;
create policy "Leaderboard hidden: admin can read" on public.leaderboard_hidden
  for select to authenticated using ((select public.is_admin()));
create policy "Leaderboard hidden: admin can add" on public.leaderboard_hidden
  for insert to authenticated with check ((select public.is_admin()));
create policy "Leaderboard hidden: admin can delete" on public.leaderboard_hidden
  for delete to authenticated using ((select public.is_admin()));

-- p_board is 'bank', 'pot' or 'achievements'. Each row's avatar is the player's face (see
-- src/accounts/avatars.ts), only if it's in the right shape. Returns the top p_limit players (at most 100),
-- plus the signed-in account's own players wherever they rank. Players show once they've
-- played 10 hands, unless they turned the leaderboard off (settings.leaderboard = false) or an
-- admin hid them.
drop function if exists public.leaderboard(text, integer);
create or replace function public.leaderboard(p_board text, p_limit integer default 25)
returns table (rank bigint, name text, color text, title text, value numeric, mine boolean, avatar text)
language sql
stable
security definer
set search_path = ''
as $$
  with scored as (
    select p.id, p.owner, p.data,
      case p_board
        when 'bank' then public.lb_num(p.data -> 'bank')
        when 'pot' then public.lb_num(p.data #> '{stats,biggestPot}')
        when 'achievements' then case when jsonb_typeof(p.data #> '{achievements,unlocked}') = 'object'
          then (select count(*) from jsonb_object_keys(p.data #> '{achievements,unlocked}'))::numeric else 0 end
        else 0
      end as value
    from public.players p
    where coalesce(p.data #> '{settings,leaderboard}', 'true'::jsonb) <> 'false'::jsonb
      and not exists (select 1 from public.leaderboard_hidden h where h.player_id = p.id)
      and public.lb_num(p.data #> '{stats,hands}') + public.lb_num(p.data #> '{achievements,counters,bj.hands}') >= 10
  ),
  ranked as (
    select s.*, rank() over (order by s.value desc) as rnk, row_number() over (order by s.value desc, s.id) as rn
    from scored s
    where s.value > 0
  )
  select r.rnk, left(coalesce(r.data ->> 'name', 'Player'), 14), r.data ->> 'color',
    case when jsonb_typeof(r.data #> '{achievements,unlocked}') = 'object' and (r.data #> '{achievements,unlocked}') ? (r.data ->> 'title')
      then r.data ->> 'title' end,
    r.value, coalesce(r.owner = auth.uid(), false),
    case when r.data ->> 'avatar' ~ '^(f:[a-z]{2,12}|u:[0-9a-f]{32})$' then r.data ->> 'avatar' end
  from ranked r
  where r.rn <= least(greatest(coalesce(p_limit, 25), 1), 100) or r.owner = auth.uid()
  order by r.rn;
$$;

revoke all on function public.leaderboard(text, integer) from public;
grant execute on function public.leaderboard(text, integer) to anon, authenticated;
