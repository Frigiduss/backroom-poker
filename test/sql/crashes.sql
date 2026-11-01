-- Checks for supabase/crashes.sql; test/sql/run.sh runs it after the other files.
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('test.uid', u, false), set_config('test.role', 'authenticated', false), set_config('test.jwt', json_build_object('aal', aal)::text, false); $$;
create or replace function pg_temp.as_visitor(ip text) returns void language sql as $$
  select set_config('test.uid', '', false), set_config('test.role', 'anon', false), set_config('test.jwt', '{}', false),
    set_config('request.headers', json_build_object('x-forwarded-for', ip || ', 10.0.0.1')::text, false); $$;
create or replace function pg_temp.ck(ok boolean, what text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAIL: %', what; end if; raise notice 'ok: %', what; end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;
insert into public.admins values ('00000000-0000-0000-0000-0000000000c3') on conflict do nothing;

-- a signed-out player reports a crash; the same error from someone else groups with it
set role anon;
select pg_temp.as_visitor('1.2.3.4');
select public.report_crash('TypeError: x is undefined', E'TypeError: x is undefined\n    at deal (https://site/:1:200)\n    at go (https://site/:1:90)', 'Blackjack', 'Chrome 130 · Windows', 'abc123');
select public.report_crash('TypeError: x is undefined', E'TypeError: x is undefined\n    at deal (https://site/:1:200)', 'Blackjack', 'Chrome 130 · Windows', 'abc123');
select pg_temp.as_visitor('5.6.7.8');
select public.report_crash('TypeError: x is undefined', E'TypeError: x is undefined\n    at deal (https://site/:1:200)', 'Roulette', 'Safari 18 · iPhone', 'abc123');
do $$ begin perform 1 from public.crash_reports; raise exception 'FAIL: visitor read crashes'; exception when insufficient_privilege then raise notice 'ok: visitors cannot read crashes'; end $$;
do $$ begin insert into public.crash_reports (fingerprint, message) values ('x', 'y'); raise exception 'FAIL: direct insert'; exception when insufficient_privilege then raise notice 'ok: no direct inserts'; end $$;
do $$ begin perform 1 from public.crash_budget; raise exception 'FAIL: budget readable'; exception when insufficient_privilege then raise notice 'ok: budget is private'; end $$;
do $$ begin perform 1 from public.crash_secret; raise exception 'FAIL: secret readable'; exception when insufficient_privilege then raise notice 'ok: secret is private'; end $$;

-- a player who isn't an admin sees nothing
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select public.report_crash(E'Bad\u0001thing ' || repeat('z', 900), repeat('s', 5000), repeat('g', 200), 'Firefox 131 · Linux', 'v1;drop');
select pg_temp.ck((select count(*) from public.crash_reports) = 0, 'players cannot read crashes');
update public.crash_reports set fixed_at = now();
select pg_temp.ck((select count(*) from public.crash_reports where fixed_at is not null) = 0, 'players cannot mark fixed');
do $$ begin update public.crash_reports set message = 'hi'; raise exception 'FAIL: message editable'; exception when insufficient_privilege then raise notice 'ok: only fixed_at is editable'; end $$;

-- the admin sees them grouped and trimmed
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck((select count(*) from public.crash_reports) = 2, 'two kinds of crash');
select pg_temp.ck((select count = 3 and people = 2 and games = '{Blackjack,Roulette}' and cardinality(browsers) = 2 and account is null from public.crash_reports where message like 'TypeError%'), 'same error grouped with games, browsers and people');
select pg_temp.ck((select length(message) = 300 and position(chr(1) in message) = 0 and length(stack) = 2000 and length(games[1]) = 60 and builds = '{v1drop}' and account = '00000000-0000-0000-0000-0000000000a1' from public.crash_reports where message like 'Bad%'), 'fields trimmed and cleaned');
update public.crash_reports set fixed_at = now() where message like 'TypeError%';
select pg_temp.ck((select fixed_at is not null from public.crash_reports where message like 'TypeError%'), 'admin marks fixed');

-- it happens again: open again
set role anon;
select pg_temp.as_visitor('9.9.9.9');
select public.report_crash('TypeError: x is undefined', E'deal@https://site/:1:200', 'Lobby', 'Safari 18 · Mac', 'abc124');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck((select count(*) from public.crash_reports) = 3, 'Safari stack is its own group');
select pg_temp.ck((select count(*) from public.crash_reports where fixed_at is not null) = 1, 'other group still fixed');

set role anon;
select pg_temp.as_visitor('1.2.3.4');
select public.report_crash('TypeError: x is undefined', E'TypeError: x is undefined\n    at deal (https://site/:1:200)', 'Lobby', '', '');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck((select fixed_at is null and count = 4 and people = 2 from public.crash_reports where message like 'TypeError%' and stack like 'TypeError%'), 'reopened when it happens again; same person not counted twice');

-- one connection can only send 30 an hour
set role anon;
select pg_temp.as_visitor('6.6.6.6');
select public.report_crash('spam ' || i, '', '', '', '') from generate_series(1, 40) i;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck((select count(*) from public.crash_reports where message like 'spam%') = 30, 'one connection is limited to 30 an hour');
-- new kinds of error are limited for everybody together
reset role;
delete from public.crash_budget where bucket like 'ip:%';
set role anon;
select pg_temp.as_visitor('7.7.7.' || (i % 250)) , public.report_crash('flood ' || i, '', '', '', '') from generate_series(1, 100) i;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck((select count(*) from public.crash_reports where message like 'flood%') = 27, '60 new kinds of error an hour in all');
-- at most 500 rows
reset role;
delete from public.crash_budget;
insert into public.crash_reports (fingerprint, message, last_at) select 'old' || i, 'old', now() - interval '1 day' - i * interval '1 minute' from generate_series(1, 600) i;
set role anon;
select pg_temp.as_visitor('8.8.8.8');
select public.report_crash('newest', '', '', '', '');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
select pg_temp.ck((select count(*) from public.crash_reports) = 500, 'keeps at most 500 rows');
select pg_temp.ck(exists (select 1 from public.crash_reports where message = 'newest'), 'newest kept');
delete from public.crash_reports where message = 'old';
select pg_temp.ck(not exists (select 1 from public.crash_reports where message = 'old'), 'admin deletes');
reset role;
