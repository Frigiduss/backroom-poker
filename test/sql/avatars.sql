-- Checks for supabase/avatars.sql and the faces leaderboard.sql and friends.sql hand out;
-- test/sql/run.sh runs it after gifts.sql on the same database.
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('test.uid', u, false), set_config('test.role', 'authenticated', false), set_config('test.jwt', json_build_object('aal', aal)::text, false); $$;
create or replace function pg_temp.ck(ok boolean, what text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAIL: %', what; end if; raise notice 'ok: %', what; end $$;
grant execute on all functions in schema pg_temp to authenticated;
select pg_temp.ck((select public and file_size_limit = 65536 and allowed_mime_types = array['image/jpeg'] from storage.buckets where id = 'avatars'), 'bucket: public, small JPEGs only');
set role authenticated;
-- Fay uploads pictures at random names, at most three
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f6');
insert into storage.objects (bucket_id, name, owner_id) values ('avatars', '0123456789abcdef0123456789abcdef.jpg', auth.uid()::text);
do $$ begin insert into storage.objects (bucket_id, name, owner_id) values ('avatars', '00000000-0000-0000-0000-0000000000f6/me.jpg', auth.uid()::text); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: names that could show the owner refused'; end $$;
do $$ begin insert into storage.objects (bucket_id, name, owner_id) values ('avatars', '0123456789abcdef0123456789abcde0.svg', auth.uid()::text); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: only .jpg names'; end $$;
insert into storage.objects (bucket_id, name, owner_id) values ('avatars', '1123456789abcdef0123456789abcdef.jpg', auth.uid()::text), ('avatars', '2123456789abcdef0123456789abcdef.jpg', auth.uid()::text);
do $$ begin insert into storage.objects (bucket_id, name, owner_id) values ('avatars', '3123456789abcdef0123456789abcdef.jpg', auth.uid()::text); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: three pictures at most'; end $$;
delete from storage.objects where name = '2123456789abcdef0123456789abcdef.jpg';
insert into storage.objects (bucket_id, name, owner_id) values ('avatars', '3123456789abcdef0123456789abcdef.jpg', auth.uid()::text);
select pg_temp.ck(true, 'deleting an old picture makes room');
-- Gus can't see or delete Fay's pictures
select pg_temp.as_user('00000000-0000-0000-0000-000000000067', 'aal2');
select pg_temp.ck((select count(*) from storage.objects) = 0, 'other accounts'' pictures not listed');
delete from storage.objects where name = '0123456789abcdef0123456789abcdef.jpg';
reset role;
select pg_temp.ck((select count(*) from storage.objects where name = '0123456789abcdef0123456789abcdef.jpg') = 1, 'other accounts can''t delete them');
set role authenticated;
-- signed in with just a password while an authenticator is on: refused
select pg_temp.as_user('00000000-0000-0000-0000-000000000067', 'aal1');
do $$ begin insert into storage.objects (bucket_id, name, owner_id) values ('avatars', 'a123456789abcdef0123456789abcdef.jpg', auth.uid()::text); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: aal1 upload refused'; end $$;
-- an admin deletes one and blocks Fay
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
delete from storage.objects where name = '0123456789abcdef0123456789abcdef.jpg';
insert into public.avatar_blocked (owner) values ('00000000-0000-0000-0000-0000000000f6');
reset role;
select pg_temp.ck((select count(*) from storage.objects where name = '0123456789abcdef0123456789abcdef.jpg') = 0, 'admins can delete any picture');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f6');
delete from storage.objects where owner_id = auth.uid()::text;
do $$ begin insert into storage.objects (bucket_id, name, owner_id) values ('avatars', 'b123456789abcdef0123456789abcdef.jpg', auth.uid()::text); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: blocked account can''t upload'; end $$;
do $$ begin insert into public.avatar_blocked (owner) values ('00000000-0000-0000-0000-000000000067'); raise exception 'FAIL'; exception when insufficient_privilege then raise notice 'ok: only admins block'; end $$;
-- faces on the leaderboard and in the friends list, only in the right shape
update public.players set data = data || '{"avatar":"u:0123456789abcdef0123456789abcdef","stats":{"hands":40}}' where id = 'pf';
select pg_temp.as_user('00000000-0000-0000-0000-000000000067', 'aal2');
update public.players set data = data || '{"avatar":"f:fox\"><script>"}' where id = 'pg';
select pg_temp.ck((select avatar from public.leaderboard('bank', 100) where name = 'Fay') = 'u:0123456789abcdef0123456789abcdef', 'leaderboard shows the picture');
select pg_temp.ck((select avatar is null from public.leaderboard('bank', 100) where name = 'Gus'), 'leaderboard drops a bad face');
select pg_temp.ck((select f->>'avatar' from jsonb_array_elements(public.friends_sync()->'friends') f where f->>'name' = 'Fay') = 'u:0123456789abcdef0123456789abcdef', 'friends list shows faces');
update public.players set data = data || '{"avatar":"f:fox"}' where id = 'pg';
select pg_temp.ck((select avatar from public.leaderboard('bank', 100) where name = 'Gus') = 'f:fox', 'leaderboard shows a face');
reset role;
