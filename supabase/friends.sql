-- Back Room Poker: friends, who's online, and table invites.
-- Run this once, after setup.sql (and multiplayer.sql, for table invites), in the SQL Editor
-- (New query → paste → Run). Running it again is safe, and needed after an update that changes it
-- (faces in the friends list: 2026-11). If multiplayer.sql hasn't been run yet,
-- friends and who's online still work; invites to a table wait until it has.
--
--   * friend_accounts   each account's friend code and when it was last seen in the game
--   * friend_links      "A wants to be friends with B". Two rows, one each way, make a friendship.
--   * table_invites     "A invited B to the table with this code", kept for 15 minutes
--
-- Browsers can't read or write these tables at all. Everything goes through the functions below,
-- which work only on the signed-in account's own friendships and check each step themselves:
-- a friend request needs the other player's friend code, a friendship needs both players to say
-- yes, only friends see each other's name and online status, and you can only invite a friend to
-- a table you're at. No function ever returns an email or an account id.

create table if not exists public.friend_accounts (
  owner uuid primary key references auth.users (id) on delete cascade,
  code text not null unique,
  last_seen timestamptz not null default now()
);

create table if not exists public.friend_links (
  from_user uuid not null references auth.users (id) on delete cascade,
  to_user uuid not null references auth.users (id) on delete cascade,
  -- The other player said no. The asker still sees the request as waiting, and asking again does nothing.
  declined boolean not null default false,
  -- The asker took back a request that was turned down. Kept, so asking again stays turned down.
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (from_user, to_user),
  check (from_user <> to_user)
);

create index if not exists friend_links_to_idx on public.friend_links (to_user);

create table if not exists public.table_invites (
  from_user uuid not null references auth.users (id) on delete cascade,
  to_user uuid not null references auth.users (id) on delete cascade,
  code text not null,
  game text not null,
  variant text,
  structure text,
  created_at timestamptz not null default now(),
  primary key (from_user, to_user)
);

create index if not exists table_invites_to_idx on public.table_invites (to_user);

alter table public.friend_accounts enable row level security;
alter table public.friend_links enable row level security;
alter table public.table_invites enable row level security;
revoke all on public.friend_accounts, public.friend_links, public.table_invites from anon, authenticated;

-- The signed-in account, after checking it finished two-step sign-in if it has it turned on.
create or replace function public.friends_me()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to an online account to use friends.' using errcode = '42501';
  end if;
  if not public.mfa_ok() then
    raise exception 'Finish two-step sign-in first.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- An account's friend code, made the first time it's needed: six letters and digits that are
-- easy to read out (no 0/O or 1/I), from the database's cryptographic random source.
create or replace function public.friend_code_of(p_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c text;
  b bytea;
begin
  select f.code into c from public.friend_accounts f where f.owner = p_user;
  if c is not null then
    return c;
  end if;
  loop
    b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    c := '';
    for i in 0..5 loop
      c := c || substr(alphabet, get_byte(b, i) % 32 + 1, 1);
    end loop;
    begin
      insert into public.friend_accounts (owner, code) values (p_user, c);
      return c;
    exception when unique_violation then
      -- Either the code is taken (try another) or this account got one a moment ago.
      select f.code into c from public.friend_accounts f where f.owner = p_user;
      if c is not null then
        return c;
      end if;
    end;
  end loop;
end;
$$;

-- What a friend sees of an account: its player's name, colour, face and title (only if earned).
create or replace function public.friend_card(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object(
      'name', left(coalesce(nullif(p.data ->> 'name', ''), 'Player'), 14),
      'color', p.data ->> 'color',
      'avatar', case when p.data ->> 'avatar' ~ '^(f:[a-z]{2,12}|u:[0-9a-f]{32})$' then p.data ->> 'avatar' end,
      'title', case when jsonb_typeof(p.data #> '{achievements,unlocked}') = 'object'
        and (p.data #> '{achievements,unlocked}') ? (p.data ->> 'title') then p.data ->> 'title' end)
    from public.players p
    where p.owner = p_user
    order by p.updated_at desc
    limit 1
  ), jsonb_build_object('name', 'Player', 'color', null, 'avatar', null, 'title', null));
$$;

-- The account behind a friend code, or an error a player can read.
create or replace function public.friend_by_code(p_code text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  u uuid;
begin
  select f.owner into u from public.friend_accounts f where f.code = c;
  if u is null then
    raise exception 'No player has the friend code %. Check it with your friend.', coalesce(nullif(c, ''), '(blank)') using errcode = 'P0001';
  end if;
  return u;
end;
$$;

create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.friend_links where from_user = a and to_user = b)
    and exists (select 1 from public.friend_links where from_user = b and to_user = a);
$$;

revoke all on function public.friends_me() from public, anon, authenticated;
revoke all on function public.friend_code_of(uuid) from public, anon, authenticated;
revoke all on function public.friend_card(uuid) from public, anon, authenticated;
revoke all on function public.friend_by_code(text) from public, anon, authenticated;
revoke all on function public.are_friends(uuid, uuid) from public, anon, authenticated;

-- Marks the account as in the game right now and returns everything the friends list shows:
-- {code, friends: [{code, name, color, title, online, seen}], incoming: [...], outgoing: [...],
--  invites: [{from, name, color, table, game, variant, structure, at}]}. Times are epoch ms.
-- The game calls it every 20 seconds or so while it's open, so "online" means seen in the last 75.
create or replace function public.friends_sync()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
  my_code text := public.friend_code_of(me);
begin
  update public.friend_accounts set last_seen = now() where owner = me;
  delete from public.table_invites where (to_user = me or from_user = me) and created_at < now() - interval '15 minutes';
  return jsonb_build_object(
    'code', my_code,
    'friends', coalesce((
      select jsonb_agg(public.friend_card(f.owner) || jsonb_build_object(
          'code', f.code,
          'online', f.last_seen > now() - interval '75 seconds',
          'seen', floor(extract(epoch from f.last_seen) * 1000))
        order by f.last_seen desc)
      from public.friend_links mine
      join public.friend_links theirs on theirs.from_user = mine.to_user and theirs.to_user = me
      join public.friend_accounts f on f.owner = mine.to_user
      where mine.from_user = me
    ), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(public.friend_card(l.from_user) || jsonb_build_object('code', f.code) order by l.created_at desc)
      from public.friend_links l
      join public.friend_accounts f on f.owner = l.from_user
      where l.to_user = me and not l.declined
        and not exists (select 1 from public.friend_links back where back.from_user = me and back.to_user = l.from_user)
    ), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(public.friend_card(l.to_user) || jsonb_build_object('code', f.code) order by l.created_at desc)
      from public.friend_links l
      join public.friend_accounts f on f.owner = l.to_user
      where l.from_user = me and not l.hidden
        and not exists (select 1 from public.friend_links back where back.from_user = l.to_user and back.to_user = me)
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
          'from', f.code, 'name', public.friend_card(i.from_user) ->> 'name', 'color', public.friend_card(i.from_user) ->> 'color',
          'avatar', public.friend_card(i.from_user) ->> 'avatar',
          'table', i.code, 'game', i.game, 'variant', i.variant, 'structure', i.structure,
          'at', floor(extract(epoch from i.created_at) * 1000))
        order by i.created_at desc)
      from public.table_invites i
      join public.friend_accounts f on f.owner = i.from_user
      where i.to_user = me and public.are_friends(me, i.from_user)
    ), '[]'::jsonb)
  );
end;
$$;

-- Sends a friend request to the player with this friend code. If they already asked you, you're
-- friends straight away. Returns {status: 'requested' | 'friends', name}.
create or replace function public.friends_add(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
  them uuid := public.friend_by_code(p_code);
begin
  perform public.friend_code_of(me);
  if them = me then
    raise exception 'That''s your own friend code. Send it to a friend so they can add you.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.friend_links where from_user = me and to_user = them) then
    if (select count(*) from public.friend_links where from_user = me) >= 300 then
      raise exception 'Your friends list is full. Remove someone to add more.' using errcode = 'P0001';
    end if;
    if (select count(*) from public.friend_links l where l.from_user = me and not l.hidden
        and not exists (select 1 from public.friend_links b where b.from_user = l.to_user and b.to_user = me)) >= 50 then
      raise exception 'You have 50 friend requests waiting for an answer. Cancel some first.' using errcode = 'P0001';
    end if;
    insert into public.friend_links (from_user, to_user) values (me, them) on conflict do nothing;
  end if;
  update public.friend_links set hidden = false where from_user = me and to_user = them and hidden;
  if exists (select 1 from public.friend_links where from_user = them and to_user = me) then
    update public.friend_links set declined = false where from_user = them and to_user = me;
    return jsonb_build_object('status', 'friends', 'name', public.friend_card(them) ->> 'name');
  end if;
  return jsonb_build_object('status', 'requested', 'name', public.friend_card(them) ->> 'name');
end;
$$;

-- Says yes or no to a friend request from the player with this code.
create or replace function public.friends_answer(p_code text, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
  them uuid := public.friend_by_code(p_code);
begin
  if not exists (select 1 from public.friend_links where from_user = them and to_user = me) then
    raise exception 'That friend request isn''t there any more.' using errcode = 'P0001';
  end if;
  if p_accept then
    insert into public.friend_links (from_user, to_user) values (me, them) on conflict do nothing;
    update public.friend_links set declined = false where from_user = them and to_user = me;
  else
    update public.friend_links set declined = true where from_user = them and to_user = me;
  end if;
end;
$$;

-- Ends a friendship, or takes back a friend request, with the player with this code.
create or replace function public.friends_remove(p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
  them uuid := public.friend_by_code(p_code);
begin
  -- A request they turned down stays turned down: it just leaves your list.
  if exists (select 1 from public.friend_links where from_user = me and to_user = them and declined) then
    update public.friend_links set hidden = true where from_user = me and to_user = them;
  else
    delete from public.friend_links where (from_user = me and to_user = them) or (from_user = them and to_user = me);
  end if;
  delete from public.table_invites where (from_user = me and to_user = them) or (from_user = them and to_user = me);
end;
$$;

-- Invites a friend to the online table with code p_table, which you must be at (playing or watching).
-- A newer invite from you to the same friend replaces the older one.
create or replace function public.friends_invite(p_code text, p_table text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
  them uuid := public.friend_by_code(p_code);
  t text := upper(regexp_replace(coalesce(p_table, ''), '[^A-Za-z0-9]', '', 'g'));
  tid uuid;
  s jsonb;
begin
  if not public.are_friends(me, them) then
    raise exception 'You can only invite friends to a table.' using errcode = '42501';
  end if;
  if to_regclass('public.poker_tables') is null or to_regclass('public.poker_views') is null then
    raise exception 'Online tables aren''t switched on yet.' using errcode = 'P0001';
  end if;
  select pt.id, pt.state -> 'settings' into tid, s from public.poker_tables pt where pt.code = t;
  if tid is null or not exists (select 1 from public.poker_views v where v.table_id = tid and v.user_id = me) then
    raise exception 'You can only invite friends to a table you''re at.' using errcode = '42501';
  end if;
  insert into public.table_invites (from_user, to_user, code, game, variant, structure, created_at)
  values (me, them, t, case when s ->> 'game' = 'blackjack' then 'blackjack' else 'poker' end, left(s ->> 'variant', 20), left(s ->> 'structure', 4), now())
  on conflict (from_user, to_user) do update
    set code = excluded.code, game = excluded.game, variant = excluded.variant, structure = excluded.structure, created_at = excluded.created_at;
end;
$$;

-- Clears the invite from the friend with this code (after joining, or saying no thanks).
create or replace function public.friends_dismiss(p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.friends_me();
  them uuid := public.friend_by_code(p_code);
begin
  delete from public.table_invites where from_user = them and to_user = me;
end;
$$;

revoke all on function public.friends_sync() from public, anon;
revoke all on function public.friends_add(text) from public, anon;
revoke all on function public.friends_answer(text, boolean) from public, anon;
revoke all on function public.friends_remove(text) from public, anon;
revoke all on function public.friends_invite(text, text) from public, anon;
revoke all on function public.friends_dismiss(text) from public, anon;
grant execute on function public.friends_sync() to authenticated;
grant execute on function public.friends_add(text) to authenticated;
grant execute on function public.friends_answer(text, boolean) to authenticated;
grant execute on function public.friends_remove(text) to authenticated;
grant execute on function public.friends_invite(text, text) to authenticated;
grant execute on function public.friends_dismiss(text) to authenticated;
