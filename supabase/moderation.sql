-- Back Room Poker: moderation for admins.
-- Run this once, after admin.sql and banks.sql (and after any of leaderboard.sql, friends.sql,
-- gifts.sql and challenges.sql you use), in the SQL Editor (New query → paste → Run).
-- Running it again is safe, and so is running it before the optional files: it switches on
-- the parts it can and skips the rest. Run it again after adding one of those files later.
--
--   * account_bans      suspended accounts, until a date or until lifted, with the reason
--   * player_overrides  changes an admin made to a player, kept in force until that player's
--                       game picks them up, so a game that is open can't save over them
--   * deleted_players   players an admin deleted, so an open game can't bring them back
--
-- A suspended account can still sign in and see why, but the database refuses its saves,
-- daily bonus, weekly challenges, friend requests, invites and chip gifts, and the table
-- server won't let it open, join or watch a table. Its players come off the leaderboard
-- while the ban lasts. Admins can't be suspended.
--
-- Browsers can't read or write these tables. Everything goes through the functions below,
-- and every admin function checks is_admin() itself.

create table if not exists public.account_bans (
  owner uuid primary key references auth.users (id) on delete cascade,
  -- null: until an admin lifts it
  until timestamptz,
  reason text not null default '',
  banned_by uuid references auth.users (id) on delete set null,
  at timestamptz not null default now(),
  -- players this ban took off the leaderboard, put back when it's lifted
  hid text[] not null default '{}'
);

create table if not exists public.player_overrides (
  player_id text primary key,
  owner uuid not null references auth.users (id) on delete cascade,
  -- fields forced on every save until the player's game collects them: bank, name, stats, history
  fields jsonb not null default '{}'::jsonb,
  -- a name kept on the player until an admin unlocks it
  name_lock text,
  at timestamptz not null default now(),
  collected_at timestamptz
);

create table if not exists public.deleted_players (
  player_id text primary key,
  owner uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);

alter table public.account_bans enable row level security;
alter table public.player_overrides enable row level security;
alter table public.deleted_players enable row level security;
revoke all on public.account_bans from anon, authenticated;
revoke all on public.player_overrides from anon, authenticated;
revoke all on public.deleted_players from anon, authenticated;
-- No policies: only the functions below (and admins in the SQL Editor) touch them.

-- ---------- bans ----------

create or replace function public.is_banned(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.account_bans where owner = p_user and (until is null or until > now()));
$$;

revoke all on function public.is_banned(uuid) from public, anon, authenticated;

-- Whether the signed-in account is suspended: {banned, until, reason}.
create or replace function public.ban_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('banned', true, 'until', b.until, 'reason', b.reason)
       from public.account_bans b where b.owner = auth.uid() and (b.until is null or b.until > now())),
    jsonb_build_object('banned', false));
$$;

revoke all on function public.ban_status() from public, anon;
grant execute on function public.ban_status() to authenticated;

-- Suspends an account for p_days days (null or 0: until lifted). Returns {until, hidden}.
create or replace function public.admin_ban(p_owner uuid, p_days numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ends timestamptz := case when coalesce(p_days, 0) > 0 then now() + make_interval(secs => least(p_days, 36500) * 86400) end;
  hid text[] := '{}';
begin
  if not public.is_admin() then
    raise exception 'Only admins can suspend accounts.' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = p_owner) then
    raise exception 'No account with that id.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.admins where user_id = p_owner) then
    raise exception 'Admins can''t be suspended. Remove them from admins first.' using errcode = 'P0001';
  end if;
  if to_regclass('public.leaderboard_hidden') is not null then
    execute 'with added as (insert into public.leaderboard_hidden (player_id)
               select id from public.players where owner = $1 on conflict do nothing returning player_id)
             select coalesce(array_agg(player_id), ''{}'') from added' into hid using p_owner;
  end if;
  insert into public.account_bans (owner, until, reason, banned_by, at, hid)
  values (p_owner, ends, left(coalesce(p_reason, ''), 200), auth.uid(), now(), hid)
  on conflict (owner) do update set until = excluded.until, reason = excluded.reason, banned_by = excluded.banned_by,
    at = excluded.at, hid = (select array(select distinct unnest(account_bans.hid || excluded.hid)));
  return jsonb_build_object('until', ends, 'hidden', cardinality(hid));
end;
$$;

-- Lifts a suspension, and puts back on the leaderboard the players it took off.
create or replace function public.admin_unban(p_owner uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.account_bans%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can lift suspensions.' using errcode = '42501';
  end if;
  delete from public.account_bans where owner = p_owner returning * into b;
  if b.owner is null then return false; end if;
  if to_regclass('public.leaderboard_hidden') is not null and cardinality(b.hid) > 0 then
    execute 'delete from public.leaderboard_hidden where player_id = any($1)' using b.hid;
  end if;
  return true;
end;
$$;

-- Every suspension still in force, newest first.
create or replace function public.admin_bans()
returns table (owner uuid, email text, until timestamptz, reason text, at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can list suspensions.' using errcode = '42501';
  end if;
  return query
    select b.owner, u.email::text, b.until, b.reason, b.at
    from public.account_bans b join auth.users u on u.id = b.owner
    where b.until is null or b.until > now()
    order by b.at desc;
end;
$$;

revoke all on function public.admin_ban(uuid, numeric, text) from public, anon;
revoke all on function public.admin_unban(uuid) from public, anon;
revoke all on function public.admin_bans() from public, anon;
grant execute on function public.admin_ban(uuid, numeric, text) to authenticated;
grant execute on function public.admin_unban(uuid) to authenticated;
grant execute on function public.admin_bans() to authenticated;

-- Refuses a row from or for a suspended account. The trigger names the uuid columns to check.
create or replace function public.ban_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  col text;
  who uuid;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or public.is_admin() then
    return new;
  end if;
  foreach col in array tg_argv loop
    who := (to_jsonb(new) ->> col)::uuid;
    if who is not null and public.is_banned(who) then
      if who = auth.uid() then
        raise exception 'This account is suspended.' using errcode = 'P0001';
      end if;
      raise exception 'That account is suspended.' using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.ban_check() from public, anon, authenticated;

do $$
declare
  t record;
begin
  for t in select * from (values
      ('daily_bonus', 'insert or update', array['owner']),
      ('weekly_challenges', 'insert', array['owner']),
      ('friend_links', 'insert', array['from_user', 'to_user']),
      ('table_invites', 'insert or update', array['from_user', 'to_user']),
      ('chip_gifts', 'insert or update', array['from_user', 'to_user'])
    ) as x(tbl, ops, cols)
  loop
    if to_regclass('public.' || t.tbl) is not null then
      execute format('drop trigger if exists ban_check on public.%I', t.tbl);
      execute format('create trigger ban_check before %s on public.%I for each row execute function public.ban_check(%s)',
        t.ops, t.tbl, (select string_agg(quote_literal(c), ', ') from unnest(t.cols) c));
    end if;
  end loop;
end $$;

-- ---------- changes to players that stick ----------

-- Runs before banks.sql's guard_player (triggers go in name order), on every save from a browser:
-- refuses suspended accounts and deleted players, and keeps an admin's changes in force.
create or replace function public.admin_rules_player()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.player_overrides%rowtype;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or public.is_admin() then
    return new;
  end if;
  if public.is_banned(new.owner) then
    raise exception 'This account is suspended, so nothing is saved online.' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' and exists (select 1 from public.deleted_players where player_id = new.id) then
    raise exception 'An admin deleted this player.' using errcode = 'P0001';
  end if;
  select * into o from public.player_overrides where player_id = new.id;
  if o.player_id is not null then
    if o.collected_at is null then
      new.data := new.data || (o.fields - 'stats');
      if o.fields ? 'stats' then
        new.data := jsonb_set(new.data, '{stats}', coalesce(new.data -> 'stats', '{}'::jsonb) || (o.fields -> 'stats'));
      end if;
    end if;
    if o.name_lock is not null then
      new.data := jsonb_set(new.data, '{name}', to_jsonb(o.name_lock));
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.admin_rules_player() from public, anon, authenticated;

drop trigger if exists admin_rules_player on public.players;
create trigger admin_rules_player before insert or update on public.players
  for each row execute function public.admin_rules_player();

-- Changes any player: p_fields may set bank, name, stats (merged key by key) and history.
-- p_lock_name true keeps the new name on the player until it's called again with false.
-- The change is saved now, and also kept in force until the player's game collects it.
-- Returns the player's data as saved.
create or replace function public.admin_edit_player(p_player text, p_fields jsonb, p_lock_name boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f jsonb := '{}'::jsonb;
  who uuid;
  out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admins can change other players.' using errcode = '42501';
  end if;
  select owner into who from public.players where id = p_player;
  if who is null then
    raise exception 'That player is gone.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_fields) <> 'object' then
    raise exception 'Nothing to change.' using errcode = 'P0001';
  end if;
  if p_fields ? 'bank' then
    if jsonb_typeof(p_fields -> 'bank') <> 'number' or (p_fields ->> 'bank')::numeric < 0 then
      raise exception 'The bank must be a number, 0 or more.' using errcode = 'P0001';
    end if;
    f := f || jsonb_build_object('bank', floor((p_fields ->> 'bank')::numeric));
  end if;
  if p_fields ? 'name' then
    if jsonb_typeof(p_fields -> 'name') <> 'string' or length(btrim(p_fields ->> 'name')) not between 1 and 14 then
      raise exception 'A name is 1 to 14 characters.' using errcode = 'P0001';
    end if;
    f := f || jsonb_build_object('name', btrim(p_fields ->> 'name'));
  end if;
  if p_fields ? 'stats' then
    if jsonb_typeof(p_fields -> 'stats') <> 'object' then
      raise exception 'Stats must be an object.' using errcode = 'P0001';
    end if;
    f := f || jsonb_build_object('stats', p_fields -> 'stats');
  end if;
  if p_fields ? 'history' then
    if jsonb_typeof(p_fields -> 'history') <> 'array' then
      raise exception 'History must be a list.' using errcode = 'P0001';
    end if;
    f := f || jsonb_build_object('history', p_fields -> 'history');
  end if;
  if f = '{}'::jsonb and p_lock_name is null then
    raise exception 'Nothing to change.' using errcode = 'P0001';
  end if;
  if p_lock_name and not f ? 'name' then
    raise exception 'Give the name to lock.' using errcode = 'P0001';
  end if;

  update public.players p
  set data = case when f ? 'stats'
               then jsonb_set(p.data || (f - 'stats'), '{stats}', coalesce(p.data -> 'stats', '{}'::jsonb) || (f -> 'stats'))
               else p.data || f end,
      updated_at = now()
  where p.id = p_player
  returning p.data into out;

  insert into public.player_overrides as o (player_id, owner, fields, name_lock, at, collected_at)
  values (p_player, who, f, case when p_lock_name then f ->> 'name' end, now(), case when f = '{}'::jsonb then now() end)
  on conflict (player_id) do update set
    -- Changes the game hasn't collected yet stay, with these on top.
    fields = case
      when f = '{}'::jsonb then o.fields
      when o.collected_at is null then
        (o.fields || (f - 'stats')) || case when f ? 'stats' or o.fields ? 'stats'
          then jsonb_build_object('stats', coalesce(o.fields -> 'stats', '{}'::jsonb) || coalesce(f -> 'stats', '{}'::jsonb)) else '{}'::jsonb end
      else f end,
    -- A locked name renamed again stays locked, on the new name.
    name_lock = case when p_lock_name = false then null
      when p_lock_name or (o.name_lock is not null and f ? 'name') then f ->> 'name'
      else o.name_lock end,
    at = now(),
    collected_at = case when f = '{}'::jsonb then o.collected_at else null end;
  return out;
end;
$$;

-- Deletes a player for good. An open game can't save it back.
create or replace function public.admin_delete_player(p_player text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  who uuid;
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete other players.' using errcode = '42501';
  end if;
  delete from public.players where id = p_player returning owner into who;
  if who is null then return false; end if;
  insert into public.deleted_players (player_id, owner) values (p_player, who) on conflict do nothing;
  delete from public.player_overrides where player_id = p_player;
  return true;
end;
$$;

-- For the player's own game: takes the changes an admin made, which the game then applies
-- and saves. {deleted: true} when an admin deleted the player; {fields: {}} when nothing waits.
create or replace function public.collect_overrides(p_player text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  got jsonb;
  lock text;
begin
  if me is null or not public.mfa_ok() then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if exists (select 1 from public.deleted_players where player_id = p_player and owner = me) then
    return jsonb_build_object('deleted', true);
  end if;
  if not exists (select 1 from public.players where id = p_player and owner = me) then
    raise exception 'That player isn''t in your account.' using errcode = '42501';
  end if;
  update public.player_overrides set collected_at = now()
  where player_id = p_player and collected_at is null
  returning fields into got;
  select name_lock into lock from public.player_overrides where player_id = p_player;
  return jsonb_build_object('fields', coalesce(got, '{}'::jsonb), 'nameLocked', lock is not null);
end;
$$;

revoke all on function public.admin_edit_player(text, jsonb, boolean) from public, anon;
revoke all on function public.admin_delete_player(text) from public, anon;
revoke all on function public.collect_overrides(text) from public, anon;
grant execute on function public.admin_edit_player(text, jsonb, boolean) to authenticated;
grant execute on function public.admin_delete_player(text) to authenticated;
grant execute on function public.collect_overrides(text) to authenticated;

-- ---------- signs of an edited bank ----------

-- Each account's bank limits from banks.sql: the win allowance left now, how many saves were
-- cut back for winning faster than real play allows (or a biggest pot past 50,000), and the
-- last free refill. Empty when banks.sql hasn't been run.
create or replace function public.admin_bank_guard()
returns table (owner uuid, allowance numeric, capped bigint, last_refill timestamptz, at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can see bank limits.' using errcode = '42501';
  end if;
  if to_regclass('public.bank_guard') is null then
    return;
  end if;
  return query execute
    'select g.owner, floor(public.bank_allowance(g)), g.clamped, nullif(g.last_refill, ''-infinity''), g.at from public.bank_guard g';
end;
$$;

revoke all on function public.admin_bank_guard() from public, anon;
grant execute on function public.admin_bank_guard() to authenticated;
