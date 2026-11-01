-- A stand-in for the parts of Supabase's auth schema the SQL files use, for test/sql/run.sh.
do $$ begin create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant create on schema public to postgres;
create table auth.users (id uuid primary key, email text, created_at timestamptz default now(), last_sign_in_at timestamptz);
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), status text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('test.role', true), '') $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'a@x'), ('00000000-0000-0000-0000-0000000000b2', 'b@x'), ('00000000-0000-0000-0000-0000000000c3', 'admin@x');
-- And for Supabase Storage, which supabase/avatars.sql sets rules on.
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner_id text, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;
