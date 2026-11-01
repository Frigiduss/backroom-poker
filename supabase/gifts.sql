-- Back Room Poker: sending chips to a friend.
-- Run this once, after friends.sql and banks.sql, in the SQL Editor (New query → paste → Run).
-- Running it again is safe.
--
--   * chip_gifts   every gift: who sent it, who it's for, how many chips, and when it was collected
--
-- Browsers can't read or write chip_gifts. Everything goes through the functions below:
--   * send_chips()     takes the chips out of the sender's saved bank on the server, then puts
--                      the gift in the friend's inbox. Only between friends, only from the bank
--                      (not chips at a table), and only by players with 10 hands played.
--   * gifts_sync()     the gifts waiting for you, and how much you can still send today
--   * collect_gifts()  takes everything waiting. The chips are added to the bank limits from
--                      banks.sql, so saving them never runs into those limits
-- Daily limits, over the last 24 hours, so chips can't be farmed with spare accounts:
--   * an account can send at most 10,000 chips
--   * an account can be sent at most 20,000 chips
--   * each gift is 100 to 10,000 chips
-- Sending gives no win allowance back (banks.sql gives it back for ordinary losses), so a gift
-- can't be used to make room for edited winnings.

create table if not exists public.chip_gifts (
  id bigint generated always as identity primary key,
  from_user uuid not null references auth.users (id) on delete cascade,
  to_user uuid not null references auth.users (id) on delete cascade,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default now(),
  collected_at timestamptz,
  check (from_user <> to_user)
);

create index if not exists chip_gifts_to_idx on public.chip_gifts (to_user, created_at);
create index if not exists chip_gifts_from_idx on public.chip_gifts (from_user, created_at);

alter table public.chip_gifts enable row level security;
revoke all on public.chip_gifts from anon, authenticated;
-- No policies: only the functions below (and admins in the SQL Editor) touch it.

-- Chips this account sent, and chips sent to it, in the last 24 hours.
create or replace function public.gifts_sent_today(p_user uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(amount), 0) from public.chip_gifts where from_user = p_user and created_at > now() - interval '24 hours';
$$;

create or replace function public.gifts_received_today(p_user uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(amount), 0) from public.chip_gifts where to_user = p_user and created_at > now() - interval '24 hours';
$$;

revoke all on function public.gifts_sent_today(uuid) from public, anon, authenticated;
revoke all on function public.gifts_received_today(uuid) from public, anon, authenticated;

-- Sends p_amount chips from your player p_player's bank to the friend with code p_code.
-- Returns {amount, bank, left, name}: bank is the player's saved bank afterwards and left is how
-- many more chips this account can send today.
create or replace function public.send_chips(p_player text, p_code text, p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
  them uuid := public.friend_by_code(p_code);
  d jsonb;
  bank numeric;
  hands numeric;
  sent bigint;
  got bigint;
  who text := public.friend_card(them) ->> 'name';
begin
  if them = me then
    raise exception 'You can''t send chips to yourself.' using errcode = 'P0001';
  end if;
  if not public.are_friends(me, them) then
    raise exception 'You can only send chips to a friend.' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 100 then
    raise exception 'Send at least 100 chips.' using errcode = 'P0001';
  end if;
  if p_amount > 10000 then
    raise exception 'A gift can be at most 10,000 chips.' using errcode = 'P0001';
  end if;
  -- One gift at a time for both accounts, in a fixed order so two friends sending to each other
  -- at once can't wait on each other.
  perform 1 from public.friend_accounts where owner in (me, them) order by owner for update;
  sent := public.gifts_sent_today(me);
  if sent + p_amount > 10000 then
    raise exception 'You can send % more chips today (10,000 a day).', to_char(greatest(0, 10000 - sent), 'FM999,999') using errcode = 'P0001';
  end if;
  got := public.gifts_received_today(them);
  if got + p_amount > 20000 then
    raise exception '% can only be sent % more chips today (20,000 a day).', who, to_char(greatest(0, 20000 - got), 'FM999,999') using errcode = 'P0001';
  end if;
  select p.data into d from public.players p where p.id = p_player and p.owner = me for update;
  if d is null then
    raise exception 'That player isn''t in your account.' using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(d -> 'table'), 'null') <> 'null' then
    raise exception 'Leave your table first. Gifts come out of your bank.' using errcode = 'P0001';
  end if;
  hands := (case when jsonb_typeof(d #> '{stats,hands}') = 'number' then (d #>> '{stats,hands}')::numeric else 0 end)
    + (case when jsonb_typeof(d #> '{achievements,counters,bj.hands}') = 'number' then (d #>> '{achievements,counters,bj.hands}')::numeric else 0 end);
  if hands < 10 then
    raise exception 'Play 10 hands before sending chips.' using errcode = 'P0001';
  end if;
  bank := case when jsonb_typeof(d -> 'bank') = 'number' then floor((d ->> 'bank')::numeric) else 0 end;
  if bank < p_amount then
    raise exception 'Your bank only has % chips.', to_char(greatest(bank, 0), 'FM999,999,999') using errcode = 'P0001';
  end if;

  update public.players set data = jsonb_set(data, '{bank}', to_jsonb(bank - p_amount)), updated_at = now() where id = p_player;
  -- banks.sql gives allowance back for chips that leave the bank. A gift isn't a loss at a table,
  -- so take that back out again.
  if to_regclass('public.bank_guard') is not null then
    update public.bank_guard set allowance = greatest(0, allowance - p_amount) where owner = me;
  end if;
  insert into public.chip_gifts (from_user, to_user, amount) values (me, them, p_amount);
  return jsonb_build_object('amount', p_amount, 'bank', bank - p_amount, 'left', 10000 - sent - p_amount, 'name', who);
end;
$$;

-- {waiting: [{from, name, color, avatar, amount, at}], left}: gifts waiting to be collected,
-- newest first, and how many chips this account can still send today. Times are epoch ms.
create or replace function public.gifts_sync()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
begin
  return jsonb_build_object(
    'waiting', coalesce((
      select jsonb_agg(public.friend_card(g.from_user) || jsonb_build_object(
          'from', f.code, 'amount', g.amount, 'at', floor(extract(epoch from g.created_at) * 1000))
        order by g.created_at desc)
      from (select * from public.chip_gifts where to_user = me and collected_at is null order by created_at desc limit 50) g
      left join public.friend_accounts f on f.owner = g.from_user
    ), '[]'::jsonb),
    'left', greatest(0, 10000 - public.gifts_sent_today(me))
  );
end;
$$;

-- Collects every gift waiting for you, for your player p_player. Returns {amount, gifts: [{name, amount}]}.
-- The browser adds amount to that player's bank and saves it.
create or replace function public.collect_gifts(p_player text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
  total bigint;
  list jsonb;
begin
  if not exists (select 1 from public.players where id = p_player and owner = me) then
    raise exception 'That player isn''t in your account.' using errcode = '42501';
  end if;
  with taken as (
    update public.chip_gifts set collected_at = now()
    where to_user = me and collected_at is null
    returning from_user, amount, created_at
  )
  select coalesce(sum(amount), 0),
    coalesce(jsonb_agg(jsonb_build_object('name', public.friend_card(from_user) ->> 'name', 'amount', amount) order by created_at), '[]'::jsonb)
  into total, list
  from taken;
  if total > 0 and to_regclass('public.bank_guard') is not null then
    insert into public.bank_guard (owner, allowance) values (me, 100000) on conflict do nothing;
    update public.bank_guard set allowance = public.bank_allowance(bank_guard) + total, at = now() where owner = me;
  end if;
  return jsonb_build_object('amount', total, 'gifts', list);
end;
$$;

revoke all on function public.send_chips(text, text, integer) from public, anon;
revoke all on function public.gifts_sync() from public, anon;
revoke all on function public.collect_gifts(text) from public, anon;
grant execute on function public.send_chips(text, text, integer) to authenticated;
grant execute on function public.gifts_sync() to authenticated;
grant execute on function public.collect_gifts(text) to authenticated;
