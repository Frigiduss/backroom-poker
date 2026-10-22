-- Back Room Poker: two-step sign-in for an existing project.
-- Projects set up before two-step sign-in run this once, after all the other files, in the
-- SQL Editor (New query → paste → Run). Running it again is safe. New projects don't need it:
-- setup.sql, admin.sql, multiplayer.sql, achievements.sql and leaderboard.sql already include it.
-- Tables from files you haven't run yet are skipped; those files add their own rule when run.
--
-- Once an account turns on two-step sign-in (profile page → Account security), a sign-in that
-- skipped the authenticator code can't read or change any of its rows, use the console's
-- account powers or collect the daily bonus. The poker-table function checks the same thing.
-- Accounts without an authenticator app carry on exactly as before.

-- True unless the signed-in account has an authenticator app and this sign-in skipped its code.
-- Restrictive policies use it, so a stolen password alone can't read or change anything.
create or replace function public.mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$$;

revoke all on function public.mfa_ok() from public;
grant execute on function public.mfa_ok() to anon, authenticated;


do $$ begin
  if to_regclass('public.players') is not null then
    drop policy if exists "Players: two-step sign-in finished" on public.players;
    create policy "Players: two-step sign-in finished" on public.players as restrictive
      for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));
  end if;
end $$;
do $$ begin
  if to_regclass('public.poker_views') is not null then
    drop policy if exists "Poker views: two-step sign-in finished" on public.poker_views;
    create policy "Poker views: two-step sign-in finished" on public.poker_views as restrictive
      for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));
  end if;
end $$;
do $$ begin
  if to_regclass('public.player_awards') is not null then
    drop policy if exists "Player awards: two-step sign-in finished" on public.player_awards;
    create policy "Player awards: two-step sign-in finished" on public.player_awards as restrictive
      for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));
  end if;
end $$;
do $$ begin
  if to_regclass('public.daily_bonus') is not null then
    drop policy if exists "Daily bonus: two-step sign-in finished" on public.daily_bonus;
    create policy "Daily bonus: two-step sign-in finished" on public.daily_bonus as restrictive
      for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));
  end if;
end $$;

-- Admin powers need the code too, for admins with an authenticator app.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid()) and public.mfa_ok();
$$;


-- The daily bonus runs with the database's own rights, so it checks for itself.
do $do$ begin
  if to_regclass('public.daily_bonus') is not null then
    execute $sql$
create or replace function public.claim_daily_bonus(p_player text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
  b public.daily_bonus%rowtype;
  day integer;
begin
  if me is null then
    raise exception 'Sign in to collect the daily bonus.' using errcode = '42501';
  end if;
  if not public.mfa_ok() then
    raise exception 'Finish two-step sign-in first.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.players where id = p_player and owner = me) then
    raise exception 'That player isn''t in your account.' using errcode = '42501';
  end if;
  insert into public.daily_bonus (owner, player_id, last_claim, streak)
  values (me, p_player, '-infinity', 0)
  on conflict do nothing;
  select * into b from public.daily_bonus where owner = me and player_id = p_player for update;
  if b.last_claim > now() - interval '20 hours' then
    return jsonb_build_object('amount', 0, 'streak', b.streak, 'last', floor(extract(epoch from b.last_claim) * 1000));
  end if;
  day := case when b.last_claim >= now() - interval '48 hours' then b.streak + 1 else 1 end;
  update public.daily_bonus set last_claim = now(), streak = day where owner = me and player_id = p_player;
  return jsonb_build_object('amount', 1000 + 500 * (least(day, 7) - 1), 'streak', day, 'last', floor(extract(epoch from now()) * 1000));
end;
$fn$
    $sql$;
  end if;
end $do$;
