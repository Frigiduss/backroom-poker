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
