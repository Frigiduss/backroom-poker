-- Checks for supabase/challenges.sql; test/sql/run.sh runs it after gifts.sql on the same database.
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('test.uid', u, false), set_config('test.role', 'authenticated', false), set_config('test.jwt', json_build_object('aal', aal)::text, false); $$;
create or replace function pg_temp.ck(ok boolean, what text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAIL: %', what; end if; raise notice 'ok: %', what; end $$;
grant execute on all functions in schema pg_temp to authenticated;
-- J plays; K is someone else.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'j@x'), ('00000000-0000-0000-0000-0000000000e2', 'k@x');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
insert into public.players (id, data) values ('pk', '{"name":"Kit","bank":10000}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
insert into public.players (id, data) values ('pj', '{"name":"Jo","bank":10000}');
select pg_temp.ck(public.challenge_week() = floor((floor(extract(epoch from now()) / 86400) + 3) / 7), 'week number from the server clock');
-- the week starts on Monday: Sunday 1 Nov 2026 and Monday 2 Nov 2026 fall in different weeks
select pg_temp.ck(floor(((date '2026-11-01' - date '1970-01-01') + 3) / 7.0) + 1 = floor(((date '2026-11-02' - date '1970-01-01') + 3) / 7.0), 'weeks turn over on Mondays');
do $$ begin insert into public.weekly_challenges (owner, week, slot, player_id, amount) values (auth.uid(), public.challenge_week(), 0, 'pj', 999999); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: browsers can''t write paid goals'; end $$;
do $$ begin perform public.claim_challenge('pk', public.challenge_week(), 0); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: someone else''s player refused'; end $$;
do $$ begin perform public.claim_challenge('pj', public.challenge_week(), 3); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: no fourth goal'; end $$;
do $$ begin perform public.claim_challenge('pj', public.challenge_week() - 1, 0); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: last week refused (%)', sqlerrm; end $$;
do $$ begin perform public.claim_challenge('pj', public.challenge_week() + 1, 0); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: next week refused'; end $$;
-- a real claim makes room in the bank limits
reset role;
update public.bank_guard set allowance = 0, at = now() where owner = '00000000-0000-0000-0000-0000000000e1';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ck((public.claim_challenge('pj', public.challenge_week(), 2)->>'amount')::int = 10000, 'hard goal pays 10,000');
select pg_temp.ck((public.claim_challenge('pj', public.challenge_week(), 2)->>'amount')::int = 0, 'paid only once');
select pg_temp.ck((public.claim_challenge('pj', public.challenge_week(), 0)->>'amount')::int = 2500, 'easy goal pays 2,500');
update public.players set data = jsonb_set(data, '{bank}', '22500') where id = 'pj';
select pg_temp.ck((select (data->>'bank')::int from public.players where id = 'pj') = 22500, 'the chips save past the bank limits');
select pg_temp.ck((select count(*) from public.weekly_challenges) = 2, 'reads only its own paid goals');
-- a second player in the same account can't be paid again
reset role;
insert into public.players (id, owner, data) values ('pj2', '00000000-0000-0000-0000-0000000000e1', '{"name":"Jo2","bank":10000}');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ck((public.claim_challenge('pj2', public.challenge_week(), 2)->>'amount')::int = 0, 'one payment per account, not per player');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
select pg_temp.ck((select count(*) from public.weekly_challenges) = 0, 'others'' paid goals hidden');
select pg_temp.ck((public.claim_challenge('pk', public.challenge_week(), 2)->>'amount')::int = 10000, 'another account is paid separately');
-- two-step sign-in and signed out
reset role;
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-0000000000e2', 'verified');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2', 'aal1');
do $$ begin perform public.claim_challenge('pk', public.challenge_week(), 1); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: aal1 refused'; end $$;
reset role;
do $$ begin perform set_config('test.uid', '', false); end $$;
set role anon;
do $$ begin perform public.claim_challenge('pk', 0, 1); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: signed out refused'; end $$;
reset role;
