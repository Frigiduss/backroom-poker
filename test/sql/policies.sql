-- Checks for the supabase/*.sql rules; test/sql/run.sh runs it on a fresh database.
\set ON_ERROR_STOP 1
insert into public.admins values ('00000000-0000-0000-0000-0000000000c3');
create or replace function pg_temp.as_user(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('test.uid', u, false), set_config('test.role', 'authenticated', false), set_config('test.jwt', json_build_object('aal', aal)::text, false); $$;
create or replace function pg_temp.ck(ok boolean, what text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAIL: %', what; end if; raise notice 'ok: %', what; end $$;
grant execute on all functions in schema pg_temp to authenticated;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
-- insert with an edited bank: capped by the 100k starting allowance
insert into public.players (id, data) values ('pa', '{"name":"A","bank":5000000,"stats":{"hands":20,"biggestPot":999999}}');
select pg_temp.ck((select (data->>'bank')::numeric from public.players where id='pa') = 110000, 'insert bank capped to 10k + 100k allowance');
select pg_temp.ck((select (data#>>'{stats,biggestPot}')::numeric from public.players where id='pa') = 50000, 'pot capped at 50k');
-- another big jump: allowance is spent
update public.players set data = jsonb_set(data, '{bank}', '9000000') where id='pa';
select pg_temp.ck((select (data->>'bank')::numeric from public.players where id='pa') between 110000 and 110100, 'no allowance left right after');
-- losing gives the allowance back, winning it back works
update public.players set data = jsonb_set(data, '{bank}', '60000') where id='pa';
update public.players set data = jsonb_set(data, '{bank}', '110000') where id='pa';
select pg_temp.ck((select (data->>'bank')::numeric from public.players where id='pa') = 110000, 'swings cost nothing');
-- refill: free once an hour
update public.players set data = jsonb_set(data, '{bank}', '500') where id='pa';
update public.players set data = jsonb_set(jsonb_set(data, '{bank}', '10000'), '{table}', 'null') where id='pa';
select pg_temp.ck((select (data->>'bank')::numeric from public.players where id='pa') = 10000, 'refill saves');
reset role;
-- pretend an hour went by for the allowance: 2,000/min * 60 = 120k (capped 500k)
update public.bank_guard set allowance = 0, at = now() - interval '60 minutes' where owner = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
update public.players set data = jsonb_set(data, '{bank}', '1000000') where id='pa';
select pg_temp.ck((select (data->>'bank')::numeric from public.players where id='pa') between 130000 and 130100, 'an hour of allowance is 120k');
-- daily bonus adds to the allowance
reset role;
update public.bank_guard set allowance = 0, at = now() where owner = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ck((public.claim_daily_bonus('pa')->>'amount')::int = 1000, 'bonus claimed');
update public.players set data = jsonb_set(data, '{bank}', to_jsonb((data->>'bank')::numeric + 1000)) where id='pa';
select pg_temp.ck((select (data->>'bank')::numeric from public.players where id='pa') between 131000 and 131100, 'bonus chips save');
-- admins aren't limited
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
update public.players set data = jsonb_set(data, '{bank}', '7777777') where id='pa';
select pg_temp.ck((select (data->>'bank')::numeric from public.players where id='pa') = 7777777, 'admin console edit goes through');
-- two-step: B with a verified factor
reset role;
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-0000000000b2', 'verified');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2', 'aal1');
do $$ begin insert into public.players (id, data) values ('pb', '{"name":"B","bank":10000}'); raise exception 'FAIL: aal1 insert allowed'; exception when insufficient_privilege then raise notice 'ok: aal1 insert refused'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2', 'aal2');
insert into public.players (id, data) values ('pb', '{"name":"B","bank":10000}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2', 'aal1');
select pg_temp.ck((select count(*) from public.players where id='pb') = 0, 'aal1 reads nothing');
do $$ begin perform public.claim_daily_bonus('pb'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: aal1 bonus refused'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2', 'aal2');
select pg_temp.ck((select count(*) from public.players where id='pb') = 1, 'aal2 reads it');
-- A can't read B
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ck((select count(*) from public.players where id='pb') = 0, 'A cannot read B');
select pg_temp.ck((select count(*) from public.leaderboard('bank', 25)) >= 1, 'leaderboard works');
do $$ begin perform * from public.bank_guard; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: bank_guard hidden'; end $$;
-- Deleting and re-adding a broke player can't mint allowance.
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
reset role;
update public.bank_guard set allowance = 0, at = now() where owner = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
insert into public.players (id, data) values ('pz', '{"name":"Z","bank":0}');
delete from public.players where id = 'pz';
insert into public.players (id, data) values ('pz', '{"name":"Z","bank":0}');
update public.players set data = jsonb_set(data, '{bank}', '50000') where id='pz';
select pg_temp.ck((select (data->>'bank')::numeric from public.players where id='pz') < 1000, 're-adding a player gives nothing back');
-- ---------- friends (supabase/friends.sql) ----------
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d4', 'd@x'), ('00000000-0000-0000-0000-0000000000e5', 'e@x');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
insert into public.players (id, data) values ('pd', '{"name":"Dana","color":"#c04040","title":"nope","bank":10000}');
select set_config('test.dcode', public.friends_sync()->>'code', false);
select pg_temp.ck(current_setting('test.dcode') ~ '^[A-HJ-NP-Z2-9]{6}$', 'friend code looks right');
select pg_temp.ck(public.friends_sync()->>'code' = current_setting('test.dcode'), 'friend code stays the same');
do $$ begin perform * from public.friend_accounts; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: friend_accounts hidden'; end $$;
do $$ begin perform * from public.friend_links; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: friend_links hidden'; end $$;
do $$ begin perform * from public.table_invites; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: table_invites hidden'; end $$;
do $$ begin perform public.friend_card('00000000-0000-0000-0000-0000000000a1'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: friend_card not callable'; end $$;
do $$ begin perform public.friends_add(current_setting('test.dcode')); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: adding yourself refused'; end $$;
do $$ begin perform public.friends_add('ZZZZZ9'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: unknown code refused'; end $$;
-- E asks D, D sees it, E sees it waiting
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e5');
insert into public.players (id, data) values ('pe', '{"name":"Eli","bank":10000}');
select set_config('test.ecode', public.friends_sync()->>'code', false);
select pg_temp.ck(public.friends_add(lower(current_setting('test.dcode')))->>'status' = 'requested', 'request sent (code in lower case)');
select pg_temp.ck(public.friends_add(current_setting('test.dcode'))->>'name' = 'Dana', 'asking twice is fine and names them');
select pg_temp.ck(jsonb_array_length(public.friends_sync()->'outgoing') = 1, 'E sees the request waiting');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
select pg_temp.ck((public.friends_sync()->'incoming'->0->>'name') = 'Eli', 'D sees the request from Eli');
select pg_temp.ck(public.friends_sync()->'incoming'->0->>'email' is null and public.friends_sync()::text not like '%0000000000e5%', 'no emails or account ids');
-- an outsider (A) can't invite or answer for D
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin perform public.friends_answer(current_setting('test.dcode'), true); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: answering a request nobody sent refused'; end $$;
do $$ begin perform public.friends_invite(current_setting('test.dcode'), 'ABCDE'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: inviting a non-friend refused'; end $$;
-- D says no: E still sees it waiting, D doesn't, asking again stays turned down
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
select public.friends_answer(current_setting('test.ecode'), false);
select pg_temp.ck(jsonb_array_length(public.friends_sync()->'incoming') = 0, 'declined request gone for D');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e5');
select pg_temp.ck(jsonb_array_length(public.friends_sync()->'outgoing') = 1, 'E still sees it waiting');
select public.friends_remove(current_setting('test.dcode'));
select pg_temp.ck(jsonb_array_length(public.friends_sync()->'outgoing') = 0, 'E took it back');
select pg_temp.ck(public.friends_add(current_setting('test.dcode'))->>'status' = 'requested', 'E asks again');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
select pg_temp.ck(jsonb_array_length(public.friends_sync()->'incoming') = 0, 'asking again after a no stays turned down');
-- D changes their mind and adds E: friends straight away
select pg_temp.ck(public.friends_add(current_setting('test.ecode'))->>'status' = 'friends', 'adding someone who asked you makes you friends');
select pg_temp.ck((public.friends_sync()->'friends'->0->>'name') = 'Eli' and (public.friends_sync()->'friends'->0->>'online')::boolean, 'D sees Eli online');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e5');
select pg_temp.ck((public.friends_sync()->'friends'->0->>'title') is null, 'unearned title hidden');
-- invites: only to a table you're at
reset role;
update public.friend_accounts set last_seen = now() - interval '10 minutes' where owner = '00000000-0000-0000-0000-0000000000d4';
insert into public.poker_tables (id, code, state) values ('00000000-0000-0000-0000-00000000aaaa', 'QWERT', '{"settings":{"variant":"omaha","structure":"PL","game":"poker"}}'), ('00000000-0000-0000-0000-00000000bbbb', 'ZXCVB', '{"settings":{"game":"blackjack"}}');
insert into public.poker_views (table_id, user_id, version, view) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000000e5', 1, '{}');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e5');
select pg_temp.ck(not (public.friends_sync()->'friends'->0->>'online')::boolean, 'D shows offline after 10 minutes');
do $$ begin perform public.friends_invite(current_setting('test.dcode'), 'ZXCVB'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: invite to a table you are not at refused'; end $$;
select public.friends_invite(current_setting('test.dcode'), 'qwert');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
select pg_temp.ck((select i->>'table' = 'QWERT' and i->>'variant' = 'omaha' and i->>'name' = 'Eli' from jsonb_array_elements(public.friends_sync()->'invites') i), 'D sees the invite');
select public.friends_dismiss(current_setting('test.ecode'));
select pg_temp.ck(jsonb_array_length(public.friends_sync()->'invites') = 0, 'dismissed invite gone');
-- unfriending clears both sides
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e5');
select public.friends_invite(current_setting('test.dcode'), 'QWERT');
select public.friends_remove(current_setting('test.dcode'));
select pg_temp.ck(jsonb_array_length(public.friends_sync()->'friends') = 0, 'unfriended');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
select pg_temp.ck(jsonb_array_length(public.friends_sync()->'friends') = 0 and jsonb_array_length(public.friends_sync()->'invites') = 0, 'both sides and invites cleared');
-- two-step sign-in: B with an authenticator, signed in with just a password, is turned away
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2', 'aal1');
do $$ begin perform public.friends_sync(); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: aal1 friends refused'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2', 'aal2');
select pg_temp.ck(public.friends_sync() ? 'code', 'aal2 friends work');
reset role;
do $$ begin perform set_config('test.uid', '', false); end $$;
set role anon;
do $$ begin perform public.friends_sync(); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: signed out refused'; end $$;
reset role;
