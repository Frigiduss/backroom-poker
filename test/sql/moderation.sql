-- Checks for supabase/moderation.sql; test/sql/run.sh runs it after the other checks on the same database.
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('test.uid', u, false), set_config('test.role', 'authenticated', false), set_config('test.jwt', json_build_object('aal', aal)::text, false); $$;
create or replace function pg_temp.ck(ok boolean, what text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAIL: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.dat(p text) returns jsonb language sql as $$ select data from public.players where id = p $$;
grant execute on all functions in schema pg_temp to authenticated;
-- M is a player, N a friend of theirs, admin@x (c3) the admin.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a7', 'm@x'), ('00000000-0000-0000-0000-0000000000a8', 'n@x'), ('00000000-0000-0000-0000-0000000000a9', 'o@x');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
insert into public.players (id, data) values ('pm', '{"name":"Mo","bank":10000,"stats":{"hands":40,"handsWon":9}}');
select set_config('test.mcode', public.friends_sync()->>'code', false);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a8');
insert into public.players (id, data) values ('pn', '{"name":"Nell","bank":10000,"stats":{"hands":40}}');
select set_config('test.ncode', public.friends_sync()->>'code', false);
select public.friends_add(current_setting('test.mcode'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a9');
select set_config('test.ocode', public.friends_sync()->>'code', false);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
select public.friends_add(current_setting('test.ncode'));

-- nothing here is open to browsers
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
do $$ begin perform * from public.account_bans; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: account_bans hidden'; end $$;
do $$ begin perform * from public.player_overrides; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: player_overrides hidden'; end $$;
do $$ begin perform public.is_banned(auth.uid()); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: is_banned not callable'; end $$;
do $$ begin perform public.admin_edit_player('pn', '{"bank":1}'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: players can''t use admin_edit_player'; end $$;
do $$ begin perform public.admin_ban('00000000-0000-0000-0000-0000000000a8', 1, 'x'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: players can''t ban'; end $$;
do $$ begin perform public.admin_bank_guard(); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: players can''t see bank limits'; end $$;
select pg_temp.ck((public.collect_overrides('pm')->'fields') = '{}'::jsonb, 'nothing to collect yet');
do $$ begin perform public.collect_overrides('pn'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: can''t collect someone else''s player'; end $$;

-- an admin change survives the player's open game saving its old copy
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck((public.admin_edit_player('pm', '{"bank":2500,"stats":{"handsWon":0}}')->>'bank')::int = 2500, 'admin sets the bank');
select pg_temp.ck(pg_temp.dat('pm')#>>'{stats,hands}' = '40', 'other stats untouched');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
update public.players set data = '{"name":"Mo","bank":10000,"stats":{"hands":41,"handsWon":10}}' where id = 'pm';
select pg_temp.ck((pg_temp.dat('pm')->>'bank')::int = 2500, 'old bank saved over it is refused');
select pg_temp.ck(pg_temp.dat('pm')#>>'{stats,handsWon}' = '0' and pg_temp.dat('pm')#>>'{stats,hands}' = '41', 'forced stat kept, the rest saves');
select pg_temp.ck((public.collect_overrides('pm')#>>'{fields,bank}')::int = 2500, 'the game collects the change');
select pg_temp.ck((public.collect_overrides('pm')->'fields') = '{}'::jsonb, 'collected once');
update public.players set data = jsonb_set(data, '{bank}', '2600') where id = 'pm';
select pg_temp.ck((pg_temp.dat('pm')->>'bank')::int = 2600, 'after collecting, play saves as usual');

-- a locked name stays, even after collecting
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select public.admin_edit_player('pm', '{"name":"Player 7"}', true);
do $$ begin perform public.admin_edit_player('pm', '{"name":"012345678901234"}'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: names are 14 characters at most'; end $$;
do $$ begin perform public.admin_edit_player('pm', '{"bank":-5}'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: no negative bank'; end $$;
do $$ begin perform public.admin_edit_player('pm', '{"owner":"x"}'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: only known fields'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
select pg_temp.ck((public.collect_overrides('pm')->>'nameLocked')::boolean, 'game told the name is locked');
update public.players set data = jsonb_set(data, '{name}', '"Mo"') where id = 'pm';
select pg_temp.ck(pg_temp.dat('pm')->>'name' = 'Player 7', 'renaming back is refused');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select public.admin_edit_player('pm', '{"name":"Mo B"}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
update public.players set data = jsonb_set(data, '{name}', '"Mo"') where id = 'pm';
select pg_temp.ck(pg_temp.dat('pm')->>'name' = 'Mo B', 'a locked name renamed again stays locked on the new name');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select public.admin_edit_player('pm', '{}', false);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
select public.collect_overrides('pm');
update public.players set data = jsonb_set(data, '{name}', '"Mo"') where id = 'pm';
select pg_temp.ck(pg_temp.dat('pm')->>'name' = 'Mo', 'unlocked: the player can rename');

-- bank limits for the admin
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck((select count(*) from public.admin_bank_guard() where owner = '00000000-0000-0000-0000-0000000000a7') = 1, 'admin sees bank limits');

-- a suspension
select pg_temp.ck((public.admin_ban('00000000-0000-0000-0000-0000000000a7', 7, 'chip farming')->>'hidden')::int = 1, 'ban hides the player from the leaderboard');
do $$ begin perform public.admin_ban('00000000-0000-0000-0000-0000000000c3', null, 'x'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: admins can''t be suspended'; end $$;
select pg_temp.ck((select count(*) from public.admin_bans() where reason = 'chip farming') = 1, 'admin lists suspensions');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
select pg_temp.ck((public.ban_status()->>'banned')::boolean and public.ban_status()->>'reason' = 'chip farming', 'the account sees it is suspended and why');
do $$ begin update public.players set data = jsonb_set(data, '{bank}', '1') where id = 'pm'; raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: saves refused (%)', sqlerrm; end $$;
do $$ begin insert into public.players (id, data) values ('pm2', '{"name":"Mo2","bank":10000,"stats":{}}'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: new players refused'; end $$;
do $$ begin perform public.claim_daily_bonus('pm'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: daily bonus refused'; end $$;
do $$ begin perform public.friends_add(current_setting('test.ocode')); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: friend requests refused'; end $$;
do $$ begin perform public.send_chips('pm', current_setting('test.ncode'), 500); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: gifts refused (%)', sqlerrm; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a8');
do $$ begin perform public.send_chips('pn', current_setting('test.mcode'), 500); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: no gifts to a suspended account (%)', sqlerrm; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a9');
do $$ begin perform public.friends_add(current_setting('test.mcode')); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: can''t befriend a suspended account'; end $$;
select pg_temp.ck(not (public.ban_status()->>'banned')::boolean, 'other accounts aren''t suspended');
reset role;
select pg_temp.ck(exists (select 1 from public.leaderboard_hidden where player_id = 'pm'), 'off the leaderboard');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck(public.admin_unban('00000000-0000-0000-0000-0000000000a7'), 'ban lifted');
reset role;
select pg_temp.ck(not exists (select 1 from public.leaderboard_hidden where player_id = 'pm'), 'back on the leaderboard');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
update public.players set data = jsonb_set(data, '{bank}', '2000') where id = 'pm';
select pg_temp.ck((pg_temp.dat('pm')->>'bank')::int = 2000, 'saves again after the ban is lifted');
-- a ban that has run out lets the account play
reset role;
insert into public.account_bans (owner, until, reason) values ('00000000-0000-0000-0000-0000000000a7', now() - interval '1 minute', 'old');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
select pg_temp.ck(not (public.ban_status()->>'banned')::boolean, 'an ended ban is over');
update public.players set data = jsonb_set(data, '{bank}', '1900') where id = 'pm';
select pg_temp.ck((pg_temp.dat('pm')->>'bank')::int = 1900, 'saves after an ended ban');

-- a deleted player can't be saved back by an open game
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck(public.admin_delete_player('pm'), 'admin deletes the player');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
do $$ begin insert into public.players (id, data) values ('pm', '{"name":"Mo","bank":10000,"stats":{}}'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: deleted player can''t come back (%)', sqlerrm; end $$;
select pg_temp.ck((public.collect_overrides('pm')->>'deleted')::boolean, 'the game learns it was deleted');
insert into public.players (id, data) values ('pm3', '{"name":"Mo","bank":10000,"stats":{}}');
select pg_temp.ck(pg_temp.dat('pm3') is not null, 'the account can start a new player');
reset role;
