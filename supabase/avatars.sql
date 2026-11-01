-- Back Room Poker: uploaded profile pictures.
-- Run this once, after setup.sql and admin.sql, in the SQL Editor (New query → paste → Run).
-- Running it again is safe. Faces picked from the game's own set need nothing here: this is only
-- for pictures players upload. Run leaderboard.sql and friends.sql again too, so the leaderboard
-- and friends list show faces.
--
--   * the `avatars` storage bucket   anyone can look at a picture by its link; nothing lists them
--   * avatar_blocked                 accounts an admin stopped from uploading pictures
--
-- What the bucket takes, whatever a browser sends:
--   * only JPEG files, at most 64 KB (the game shrinks pictures to 160×160 before sending)
--   * only from signed-in accounts that finished two-step sign-in, and not blocked ones
--   * only at a random 32-character name, so links never show who owns them
--   * at most 3 pictures per account at a time (the game deletes the old one after a new upload)
--   * no overwriting: a new picture is a new file
--   * each account can delete only its own pictures; admins can delete any (console: edit <player> picture off)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 65536, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 65536, allowed_mime_types = array['image/jpeg'];

create table if not exists public.avatar_blocked (
  owner uuid primary key references auth.users (id) on delete cascade,
  blocked_at timestamptz not null default now()
);

alter table public.avatar_blocked enable row level security;
revoke all on public.avatar_blocked from anon, authenticated;
grant select, insert, delete on public.avatar_blocked to authenticated;
drop policy if exists "Avatar blocked: admin can read" on public.avatar_blocked;
drop policy if exists "Avatar blocked: admin can add" on public.avatar_blocked;
drop policy if exists "Avatar blocked: admin can delete" on public.avatar_blocked;
create policy "Avatar blocked: admin can read" on public.avatar_blocked
  for select to authenticated using ((select public.is_admin()));
create policy "Avatar blocked: admin can add" on public.avatar_blocked
  for insert to authenticated with check ((select public.is_admin()));
create policy "Avatar blocked: admin can delete" on public.avatar_blocked
  for delete to authenticated using ((select public.is_admin()));

-- True when the signed-in account may upload another picture.
create or replace function public.avatar_upload_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and public.mfa_ok()
    and not exists (select 1 from public.avatar_blocked b where b.owner = auth.uid())
    and (select count(*) from storage.objects o where o.bucket_id = 'avatars' and o.owner_id = auth.uid()::text) < 3;
$$;

revoke all on function public.avatar_upload_ok() from public, anon;
grant execute on function public.avatar_upload_ok() to authenticated;

drop policy if exists "Avatars: upload your own" on storage.objects;
drop policy if exists "Avatars: see your own" on storage.objects;
drop policy if exists "Avatars: delete your own" on storage.objects;
create policy "Avatars: upload your own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and name ~ '^[0-9a-f]{32}\.jpg$' and (select public.avatar_upload_ok()));
-- Reading a picture goes through its public link and needs no policy. This one lets the storage
-- server find an account's own files when it deletes them.
create policy "Avatars: see your own" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (owner_id = (select auth.uid()::text) or (select public.is_admin())));
create policy "Avatars: delete your own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (owner_id = (select auth.uid()::text) or (select public.is_admin())));
