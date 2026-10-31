-- friends.sql without multiplayer.sql: run by test/sql/run.sh.
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(u text) returns void language sql as $$
  select set_config('test.uid', u, false), set_config('test.jwt', '{"aal":"aal1"}', false); $$;
grant execute on all functions in schema pg_temp to authenticated;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select set_config('test.acode', public.friends_sync()->>'code', false);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select public.friends_sync();
select public.friends_add(current_setting('test.acode'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select public.friends_add(public.friends_sync()->'incoming'->0->>'code');
do $$ begin perform public.friends_invite(public.friends_sync()->'friends'->0->>'code', 'ABCDE'); raise exception 'FAIL'; exception when raise_exception then raise notice 'ok: invites wait for online tables (%)', sqlerrm; end $$;
