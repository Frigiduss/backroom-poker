-- Back Room Poker: notifications ("it's your turn" at an online table, and a friend inviting you to theirs).
-- Run this once, after setup.sql and friends.sql, in the SQL Editor (New query → paste → Run).
-- Running it again is safe. It adds:
--   * push_keys        the table server's signing key for push services, made by the server itself the
--                      first time it's needed. Only the server can read it.
--   * push_devices     each phone or browser that turned notifications on, and which ones it wants
--   * push_presence    whether someone has the game in front of them right now (then nothing is sent)
--   * push_invite_sent which invites were already sent as a notification, so each goes once
--
-- Browsers can't read or write these tables. They go through push_save, push_remove, push_status and
-- push_awake, which only touch the signed-in account's own devices. The table server (poker-table
-- function, with the service key) asks push_targets who to tell and push_invite whether an invite is real.

create table if not exists public.push_keys (
  id integer primary key default 1 check (id = 1),
  public_key text not null,
  private_jwk jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.push_devices (
  -- the address the browser's push service gave this device
  endpoint text primary key,
  owner uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  turns boolean not null default true,
  invites boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_devices_owner_idx on public.push_devices (owner);

create table if not exists public.push_presence (
  owner uuid not null references auth.users (id) on delete cascade,
  -- a random id each browser keeps for itself
  device text not null,
  awake_until timestamptz not null,
  primary key (owner, device)
);

create table if not exists public.push_invite_sent (
  from_user uuid not null references auth.users (id) on delete cascade,
  to_user uuid not null references auth.users (id) on delete cascade,
  invited_at timestamptz not null,
  primary key (from_user, to_user)
);

alter table public.push_keys enable row level security;
alter table public.push_devices enable row level security;
alter table public.push_presence enable row level security;
alter table public.push_invite_sent enable row level security;
revoke all on public.push_keys, public.push_devices, public.push_presence, public.push_invite_sent from anon, authenticated;
grant select, insert on public.push_keys to service_role;
grant select, delete on public.push_devices to service_role;

-- The signed-in account, after checking it finished two-step sign-in if it has it turned on.
create or replace function public.push_me()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to an online account to get notifications.' using errcode = '42501';
  end if;
  if not public.mfa_ok() then
    raise exception 'Finish two-step sign-in first.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- Push services of Chrome/Android, Firefox, Safari/iPhone and Edge. The server only ever posts to these.
create or replace function public.push_endpoint_ok(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(length(p) <= 1000 and p ~ '^https://(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)/', false);
$$;

-- Turns notifications on (or changes which ones) for this device. A device that belonged to another
-- account (someone else signed in on it before) moves to this one. At most 10 devices an account.
create or replace function public.push_save(p_endpoint text, p_p256dh text, p_auth text, p_turns boolean, p_invites boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.push_me();
begin
  if not public.push_endpoint_ok(p_endpoint) then
    raise exception 'This browser''s notifications aren''t supported.' using errcode = 'P0001';
  end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{86,88}={0,2}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{21,24}={0,2}$' then
    raise exception 'That notification sign-up looks broken. Try turning notifications off and on.' using errcode = 'P0001';
  end if;
  insert into public.push_devices (endpoint, owner, p256dh, auth, turns, invites, updated_at)
  values (p_endpoint, me, rtrim(p_p256dh, '='), rtrim(p_auth, '='), coalesce(p_turns, true), coalesce(p_invites, true), clock_timestamp())
  on conflict (endpoint) do update
    set owner = me, p256dh = excluded.p256dh, auth = excluded.auth, turns = excluded.turns, invites = excluded.invites, updated_at = excluded.updated_at;
  delete from public.push_devices d
  where d.owner = me and d.endpoint in (
    select x.endpoint from public.push_devices x where x.owner = me order by x.updated_at desc offset 10);
end;
$$;

-- Turns notifications off for this device.
create or replace function public.push_remove(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.push_me();
begin
  delete from public.push_devices where endpoint = p_endpoint and owner = me;
end;
$$;

-- What this device gets: {turns, invites}, or null if it isn't signed up (or belongs to another account).
create or replace function public.push_status(p_endpoint text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me uuid := public.push_me();
begin
  return (select jsonb_build_object('turns', d.turns, 'invites', d.invites) from public.push_devices d where d.endpoint = p_endpoint and d.owner = me);
end;
$$;

-- "I'm looking at the game" (for two minutes, renewed while it stays in front) or "I've put it away".
-- While any of an account's devices is looking, nothing is sent to its phones.
create or replace function public.push_awake(p_device text, p_awake boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.push_me();
begin
  if coalesce(p_device, '') !~ '^[A-Za-z0-9_-]{8,40}$' then
    raise exception 'Bad device id.' using errcode = 'P0001';
  end if;
  insert into public.push_presence (owner, device, awake_until)
  values (me, p_device, case when p_awake then now() + interval '2 minutes' else now() end)
  on conflict (owner, device) do update set awake_until = excluded.awake_until;
  delete from public.push_presence where owner = me and awake_until < now() - interval '1 day';
end;
$$;

-- For the table server: the devices to tell about a turn ('turn') or an invite ('invite'). None while
-- the person has the game in front of them on any device.
create or replace function public.push_targets(p_user uuid, p_kind text)
returns table (endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.endpoint, d.p256dh, d.auth
  from public.push_devices d
  where d.owner = p_user
    and case when p_kind = 'turn' then d.turns when p_kind = 'invite' then d.invites else false end
    and not exists (select 1 from public.push_presence p where p.owner = p_user and p.awake_until > now())
  order by d.updated_at desc
  limit 10;
$$;

-- For the table server, after a player says they invited a friend: the invite (made in the last two
-- minutes by friends_invite) and who to tell, or null if there's nothing new to send. One notification
-- per friend a minute, however often they're invited.
create or replace function public.push_invite(p_from uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  them uuid;
  inv record;
  fresh boolean;
begin
  if to_regclass('public.table_invites') is null then
    return null;
  end if;
  select f.owner into them from public.friend_accounts f where f.code = c;
  if them is null then
    return null;
  end if;
  select i.code, i.game, i.variant, i.structure, i.created_at into inv
  from public.table_invites i
  where i.from_user = p_from and i.to_user = them and i.created_at > now() - interval '2 minutes';
  if not found then
    return null;
  end if;
  insert into public.push_invite_sent as s (from_user, to_user, invited_at) values (p_from, them, inv.created_at)
  on conflict (from_user, to_user) do update set invited_at = excluded.invited_at
    where s.invited_at < excluded.invited_at - interval '1 minute'
  returning true into fresh;
  if fresh is null then
    return null;
  end if;
  return jsonb_build_object('to', them, 'name', public.friend_card(p_from) ->> 'name', 'table', inv.code,
    'game', inv.game, 'variant', inv.variant, 'structure', inv.structure);
end;
$$;

revoke all on function public.push_me() from public, anon, authenticated;
revoke all on function public.push_save(text, text, text, boolean, boolean) from public, anon;
revoke all on function public.push_remove(text) from public, anon;
revoke all on function public.push_status(text) from public, anon;
revoke all on function public.push_awake(text, boolean) from public, anon;
revoke all on function public.push_targets(uuid, text) from public, anon, authenticated;
revoke all on function public.push_invite(uuid, text) from public, anon, authenticated;
grant execute on function public.push_save(text, text, text, boolean, boolean) to authenticated;
grant execute on function public.push_remove(text) to authenticated;
grant execute on function public.push_status(text) to authenticated;
grant execute on function public.push_awake(text, boolean) to authenticated;
grant execute on function public.push_targets(uuid, text) to service_role;
grant execute on function public.push_invite(uuid, text) to service_role;
