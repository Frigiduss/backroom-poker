-- Checks for supabase/gifts.sql; test/sql/run.sh runs it after policies.sql on the same database.
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('test.uid', u, false), set_config('test.role', 'authenticated', false), set_config('test.jwt', json_build_object('aal', aal)::text, false); $$;
create or replace function pg_temp.ck(ok boolean, what text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAIL: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.bank(p text) returns numeric language sql as $$ select (data->>'bank')::numeric from public.players where id = p $$;
grant execute on all functions in schema pg_temp to authenticated;
-- F and G are fresh accounts; H is a stranger.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f6', 'f@x'), ('00000000-0000-0000-0000-000000000067', 'g@x'), ('00000000-0000-0000-0000-000000000068', 'h@x');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f6');
insert into public.players (id, data) values ('pf', '{"name":"Fay","bank":10000,"stats":{"hands":3}}');
select set_config('test.fcode', public.friends_sync()->>'code', false);
select pg_temp.as_user('00000000-0000-0000-0000-000000000068');
insert into public.players (id, data) values ('ph', '{"name":"Hal","bank":10000,"stats":{"hands":30}}');
select set_config('test.hcode', public.friends_sync()->>'code', false);
select pg_temp.as_user('00000000-0000-0000-0000-000000000067');
insert into public.players (id, data) values ('pg', '{"name":"Gus","bank":10000,"stats":{"hands":50}}');
select set_config('test.gcode', public.friends_sync()->>'code', false);
select public.friends_add(current_setting('test.fcode'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f6');
select public.friends_add(current_setting('test.gcode'));
do $$ begin perform * from public.chip_gifts; raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: chip_gifts hidden'; end $$;
do $$ begin perform public.gifts_sent_today(auth.uid()); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: helpers not callable'; end $$;
-- Fay hasn't played 10 hands yet; Hal isn't a friend
do $$ begin perform public.send_chips('pf', current_setting('test.gcode'), 500); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: 10 hands first (%)', sqlerrm; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000068');
do $$ begin perform public.send_chips('ph', current_setting('test.gcode'), 500); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: strangers refused'; end $$;
-- Gus sends: limits on the size of a gift, someone else's player, chips at a table
select pg_temp.as_user('00000000-0000-0000-0000-000000000067');
do $$ begin perform public.send_chips('pg', current_setting('test.fcode'), 99); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: at least 100'; end $$;
do $$ begin perform public.send_chips('pg', current_setting('test.fcode'), 10001); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: at most 10,000 a gift'; end $$;
do $$ begin perform public.send_chips('ph', current_setting('test.fcode'), 500); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: someone else''s player refused'; end $$;
do $$ begin perform public.send_chips('pg', current_setting('test.gcode'), 500); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: not to yourself'; end $$;
update public.players set data = jsonb_set(data, '{table}', '{"kind":"cash","paidIn":2000,"stack":2000}') where id = 'pg';
do $$ begin perform public.send_chips('pg', current_setting('test.fcode'), 500); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: not with chips at a table'; end $$;
update public.players set data = jsonb_set(data, '{table}', 'null') where id = 'pg';
-- a real gift
reset role;
update public.bank_guard set allowance = 0, at = now() where owner = '00000000-0000-0000-0000-000000000067';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000000067');
select pg_temp.ck((public.send_chips('pg', current_setting('test.fcode'), 4000)->>'bank')::numeric = 6000, 'gift taken from the saved bank');
select pg_temp.ck(pg_temp.bank('pg') = 6000, 'bank saved at 6,000');
select set_config('test.role', '', false);
update public.players set data = jsonb_set(data, '{bank}', '1000') where id = 'pg';
select set_config('test.role', 'authenticated', false);
do $$ begin perform public.send_chips('pg', current_setting('test.fcode'), 2000); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: can''t send more than the bank (%)', sqlerrm; end $$;
select set_config('test.role', '', false);
update public.players set data = jsonb_set(data, '{bank}', '6000') where id = 'pg';
select set_config('test.role', 'authenticated', false);
-- sending gave no allowance back: winning it straight back is capped
update public.players set data = jsonb_set(data, '{bank}', '10000') where id = 'pg';
select pg_temp.ck(pg_temp.bank('pg') < 6200, 'a gift makes no room for edited winnings');
select pg_temp.ck((public.gifts_sync()->>'left')::int = 6000, 'Gus can send 6,000 more today');
-- Fay sees it and collects it
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f6');
select pg_temp.ck((select g->>'name' = 'Gus' and (g->>'amount')::int = 4000 and g->>'from' = current_setting('test.gcode') from jsonb_array_elements(public.gifts_sync()->'waiting') g), 'Fay sees the gift from Gus');
select pg_temp.ck(public.gifts_sync()::text not like '%000000000067%', 'no account ids');
reset role;
update public.bank_guard set allowance = 0, at = now() where owner = '00000000-0000-0000-0000-0000000000f6';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f6');
do $$ begin perform public.collect_gifts('pg'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: collecting into someone else''s player refused'; end $$;
select pg_temp.ck((public.collect_gifts('pf')->>'amount')::int = 4000, 'collected 4,000');
select pg_temp.ck((public.collect_gifts('pf')->>'amount')::int = 0, 'collecting twice gives nothing');
update public.players set data = jsonb_set(data, '{bank}', '14000') where id = 'pf';
select pg_temp.ck(pg_temp.bank('pf') between 14000 and 14100, 'collected chips save past the bank limits');
select pg_temp.ck(jsonb_array_length(public.gifts_sync()->'waiting') = 0, 'nothing waiting after collecting');
-- daily limits: sending 10,000, receiving 20,000
select pg_temp.as_user('00000000-0000-0000-0000-000000000067');
update public.players set data = jsonb_set(data, '{bank}', '6000') where id = 'pg';
select public.send_chips('pg', current_setting('test.fcode'), 6000);
select set_config('test.role', '', false);
update public.players set data = jsonb_set(data, '{bank}', '50000') where id = 'pg';
select pg_temp.as_user('00000000-0000-0000-0000-000000000067');
do $$ begin perform public.send_chips('pg', current_setting('test.fcode'), 100); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: 10,000 a day sent (%)', sqlerrm; end $$;
reset role;
update public.chip_gifts set created_at = now() - interval '25 hours';
insert into public.chip_gifts (from_user, to_user, amount) values ('00000000-0000-0000-0000-000000000068', '00000000-0000-0000-0000-0000000000f6', 15000);
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000000067');
do $$ begin perform public.send_chips('pg', current_setting('test.fcode'), 6000); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: 20,000 a day received (%)', sqlerrm; end $$;
select pg_temp.ck((public.send_chips('pg', current_setting('test.fcode'), 5000)->>'left')::int = 5000, 'a day later Gus can send again, up to Fay''s limit');
-- two-step sign-in and signed out
reset role;
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-000000000067', 'verified');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000000067', 'aal1');
do $$ begin perform public.gifts_sync(); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: aal1 gifts refused'; end $$;
reset role;
do $$ begin perform set_config('test.uid', '', false); end $$;
set role anon;
do $$ begin perform public.gifts_sync(); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: signed out refused'; end $$;
reset role;
