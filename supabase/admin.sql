-- Back Room Poker: the developer console.
-- Run this once, after setup.sql (it needs mfa_ok() from there), in the SQL Editor (New query → paste → Run). Running it
-- again is safe. It adds:
--   * admins       accounts allowed to use the console (add yourself at the bottom)
--   * is_admin()   true when the signed-in account is an admin
--   * admin rights on players: admins can read, change and delete every account's players
--   * admin_accounts()  every account with its email, sign-up and last sign-in
--   * site         public settings such as the lobby announcement; only admins can change them
--   * admin_log    a record of what was done from the console
-- Nothing here trusts the browser: every admin power is checked by the database.

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table public.admins enable row level security;
drop policy if exists "Admins: see own row" on public.admins;
create policy "Admins: see own row" on public.admins
  for select to authenticated using (user_id = auth.uid());
grant select on public.admins to authenticated;
-- No insert, update or delete policy: admins can only be added here in the SQL Editor.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid()) and public.mfa_ok();
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Admins can see and manage every player, on top of the owner rules from setup.sql.
drop policy if exists "Players: admin can read" on public.players;
drop policy if exists "Players: admin can change" on public.players;
drop policy if exists "Players: admin can delete" on public.players;
create policy "Players: admin can read" on public.players
  for select to authenticated using ((select public.is_admin()));
create policy "Players: admin can change" on public.players
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Players: admin can delete" on public.players
  for delete to authenticated using ((select public.is_admin()));

create or replace function public.admin_accounts()
returns table (id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz, players bigint, admin boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can list accounts.' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at,
      (select count(*) from public.players p where p.owner = u.id),
      exists (select 1 from public.admins a where a.user_id = u.id)
    from auth.users u
    order by u.last_sign_in_at desc nulls last;
end;
$$;

revoke all on function public.admin_accounts() from public, anon;
grant execute on function public.admin_accounts() to authenticated;

create table if not exists public.site (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.site enable row level security;
drop policy if exists "Site: anyone can read" on public.site;
drop policy if exists "Site: admin can add" on public.site;
drop policy if exists "Site: admin can change" on public.site;
drop policy if exists "Site: admin can delete" on public.site;
create policy "Site: anyone can read" on public.site for select to anon, authenticated using (true);
create policy "Site: admin can add" on public.site for insert to authenticated with check ((select public.is_admin()));
create policy "Site: admin can change" on public.site
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Site: admin can delete" on public.site for delete to authenticated using ((select public.is_admin()));
grant select on public.site to anon, authenticated;
grant insert, update, delete on public.site to authenticated;

create table if not exists public.admin_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  admin uuid not null default auth.uid() references auth.users (id) on delete cascade,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);

alter table public.admin_log enable row level security;
drop policy if exists "Admin log: admin can read" on public.admin_log;
drop policy if exists "Admin log: admin can add" on public.admin_log;
create policy "Admin log: admin can read" on public.admin_log
  for select to authenticated using ((select public.is_admin()));
create policy "Admin log: admin can add" on public.admin_log
  for insert to authenticated with check ((select public.is_admin()) and admin = auth.uid());
grant select, insert on public.admin_log to authenticated;

-- Make your own account an admin: put the email you signed up with between the quotes.
-- (Sign up in the game first, so the account exists.)
insert into public.admins (user_id)
select id from auth.users where lower(email) = lower('YOUR-EMAIL@example.com')
on conflict do nothing;
