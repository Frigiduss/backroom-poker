-- Checks for supabase/push.sql; test/sql/run.sh runs it after the other checks on the same database.
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('test.uid', u, false), set_config('test.role', 'authenticated', false), set_config('test.jwt', json_build_object('aal', aal)::text, false); $$;
create or replace function pg_temp.ck(ok boolean, what text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAIL: %', what; end if; raise notice 'ok: %', what; end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;
-- P and Q are friends; R is someone else.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'p@x'), ('00000000-0000-0000-0000-0000000000d2', 'q@x'), ('00000000-0000-0000-0000-0000000000d3', 'r@x');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
insert into public.players (id, data) values ('pp', '{"name":"Pat","bank":1000}');
select set_config('test.pcode', public.friends_sync()->>'code', false);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
insert into public.players (id, data) values ('pq', '{"name":"Quinn","bank":1000}');
select set_config('test.qcode', public.friends_sync()->>'code', false);
select public.friends_add(current_setting('test.pcode'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
select public.friends_add(current_setting('test.qcode'));

do $$ begin perform * from public.push_devices; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: push_devices hidden'; end $$;
do $$ begin perform * from public.push_keys; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: push_keys hidden'; end $$;
do $$ begin perform * from public.push_presence; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: push_presence hidden'; end $$;
do $$ begin perform * from public.push_targets('00000000-0000-0000-0000-0000000000d1', 'turn'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: push_targets is for the server only'; end $$;
do $$ begin perform public.push_invite('00000000-0000-0000-0000-0000000000d1', 'X'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: push_invite is for the server only'; end $$;

-- Signing up a device: only real push services, well-formed keys
do $$ begin perform public.push_save('https://evil.example/x', repeat('A', 87), repeat('B', 22), true, true); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: unknown push service refused'; end $$;
do $$ begin perform public.push_save('https://fcm.googleapis.com.evil.example/x', repeat('A', 87), repeat('B', 22), true, true); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: lookalike host refused'; end $$;
do $$ begin perform public.push_save('https://fcm.googleapis.com/fcm/send/p1', 'short', repeat('B', 22), true, true); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: broken keys refused'; end $$;
select public.push_save('https://fcm.googleapis.com/fcm/send/p1', repeat('A', 87), repeat('B', 22) || '==', true, false);
select pg_temp.ck(public.push_status('https://fcm.googleapis.com/fcm/send/p1') = '{"turns": true, "invites": false}', 'status of this device');
select pg_temp.ck(public.push_status('https://fcm.googleapis.com/fcm/send/nope') is null, 'unknown device has no status');
select public.push_save('https://fcm.googleapis.com/fcm/send/p1', repeat('A', 87), repeat('B', 22), true, true);
select pg_temp.ck(public.push_status('https://fcm.googleapis.com/fcm/send/p1') = '{"turns": true, "invites": true}', 'saving again changes the choices');

-- Two-step sign-in must be finished
reset role;
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-0000000000d3', 'verified');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d3');
do $$ begin perform public.push_save('https://web.push.apple.com/r1', repeat('A', 87), repeat('B', 22), true, true); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: needs the second step'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d3', 'aal2');
-- R can't see or remove P's device; signing up the same browser moves it to R
select pg_temp.ck(public.push_status('https://fcm.googleapis.com/fcm/send/p1') is null, 'another account''s device has no status');
select public.push_remove('https://fcm.googleapis.com/fcm/send/p1');
reset role;
select pg_temp.ck((select count(*) from public.push_devices where owner = '00000000-0000-0000-0000-0000000000d1') = 1, 'another account can''t remove it');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d3', 'aal2');
select public.push_save('https://fcm.googleapis.com/fcm/send/p1', repeat('A', 87), repeat('B', 22), true, true);
reset role;
select pg_temp.ck((select owner from public.push_devices where endpoint = 'https://fcm.googleapis.com/fcm/send/p1') = '00000000-0000-0000-0000-0000000000d3', 'a browser signed in with another account moves to it');
set role authenticated;
-- at most 10 devices an account
do $$ begin for i in 1..12 loop perform public.push_save('https://web.push.apple.com/r' || i, repeat('A', 87), repeat('B', 22), true, true); end loop; end $$;
reset role;
select pg_temp.ck((select count(*) from public.push_devices where owner = '00000000-0000-0000-0000-0000000000d3') = 10, 'ten devices kept');
select pg_temp.ck(exists (select 1 from public.push_devices where endpoint = 'https://web.push.apple.com/r12'), 'the newest kept');
set role authenticated;

-- P's phone; who to tell depends on what it wants and whether P has the game in front of them
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
select public.push_save('https://web.push.apple.com/pat', repeat('A', 87), repeat('B', 22), true, false);
do $$ begin perform public.push_awake('x', true); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: bad device id refused'; end $$;
set role service_role;
select pg_temp.ck((select count(*) from public.push_targets('00000000-0000-0000-0000-0000000000d1', 'turn')) = 1, 'the phone gets turns');
select pg_temp.ck((select count(*) from public.push_targets('00000000-0000-0000-0000-0000000000d1', 'invite')) = 0, 'but not invites');
set role authenticated;
select public.push_awake('desktop-1234', true);
set role service_role;
select pg_temp.ck((select count(*) from public.push_targets('00000000-0000-0000-0000-0000000000d1', 'turn')) = 0, 'nothing while the game is in front of them');
set role authenticated;
select public.push_awake('phone-12345', false);
set role service_role;
select pg_temp.ck((select count(*) from public.push_targets('00000000-0000-0000-0000-0000000000d1', 'turn')) = 0, 'another device going away doesn''t count');
set role authenticated;
select public.push_awake('desktop-1234', false);
set role service_role;
select pg_temp.ck((select count(*) from public.push_targets('00000000-0000-0000-0000-0000000000d1', 'turn')) = 1, 'sent again once every device is put away');
-- the server can read its key and drop dead devices
insert into public.push_keys (id, public_key, private_jwk) values (1, 'pub', '{}') on conflict do nothing;
select pg_temp.ck((select public_key from public.push_keys) = 'pub', 'server reads its key');
delete from public.push_devices where endpoint = 'https://web.push.apple.com/r12';

-- Invites: only a real, recent invite, once a minute per friend
reset role;
insert into public.table_invites (from_user, to_user, code, game, variant, structure) values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1', 'ABCDE', 'poker', 'holdem', 'NL');
set role service_role;
select pg_temp.ck(public.push_invite('00000000-0000-0000-0000-0000000000d3', current_setting('test.pcode')) is null, 'no invite, nothing sent');
select pg_temp.ck(public.push_invite('00000000-0000-0000-0000-0000000000d2', 'ZZZZZZ') is null, 'unknown friend code');
select pg_temp.ck(public.push_invite('00000000-0000-0000-0000-0000000000d2', current_setting('test.pcode')) = jsonb_build_object('to', '00000000-0000-0000-0000-0000000000d1'::uuid, 'name', 'Quinn', 'table', 'ABCDE', 'game', 'poker', 'variant', 'holdem', 'structure', 'NL'), 'a real invite');
select pg_temp.ck(public.push_invite('00000000-0000-0000-0000-0000000000d2', current_setting('test.pcode')) is null, 'sent only once');
reset role;
update public.table_invites set created_at = now() + interval '30 seconds' where from_user = '00000000-0000-0000-0000-0000000000d2';
set role service_role;
select pg_temp.ck(public.push_invite('00000000-0000-0000-0000-0000000000d2', current_setting('test.pcode')) is null, 'a new invite within a minute isn''t sent');
reset role;
update public.table_invites set created_at = now() + interval '90 seconds' where from_user = '00000000-0000-0000-0000-0000000000d2';
set role service_role;
select pg_temp.ck(public.push_invite('00000000-0000-0000-0000-0000000000d2', current_setting('test.pcode')) is not null, 'a new invite a minute later is');
reset role;
update public.table_invites set created_at = now() - interval '5 minutes' where from_user = '00000000-0000-0000-0000-0000000000d2';
delete from public.push_invite_sent;
set role service_role;
select pg_temp.ck(public.push_invite('00000000-0000-0000-0000-0000000000d2', current_setting('test.pcode')) is null, 'an old invite isn''t sent');
reset role;
