-- Back Room Poker: chips for weekly challenges.
-- Run this once, after banks.sql, in the SQL Editor (New query → paste → Run). Running it again is safe.
--
-- Every week (Monday 00:00 UTC) the game shows three goals: easy, medium and hard. Finishing
-- one pays 2,500, 5,000 or 10,000 chips, once per account per week. The browser picks the
-- goals and counts progress (games against bots happen there); this file makes sure the
-- chips can only be collected once, only in the week they belong to, and only in those amounts:
--
--   * weekly_challenges   which goals each account has been paid for, and when. Browsers can
--                         read their own rows but never write them.
--   * claim_challenge()   pays a goal if it hasn't been paid yet this week. The server's clock
--                         decides which week it is. The chips are added to the bank limits
--                         from banks.sql, so saving them never runs into those.
-- So the most a player can ever collect from challenges is 17,500 chips a week.

create table if not exists public.weekly_challenges (
  owner uuid not null references auth.users (id) on delete cascade,
  week integer not null,
  slot smallint not null check (slot between 0 and 2),
  player_id text not null,
  amount integer not null,
  claimed_at timestamptz not null default now(),
  primary key (owner, week, slot)
);

alter table public.weekly_challenges enable row level security;
revoke all on public.weekly_challenges from anon, authenticated;
grant select on public.weekly_challenges to authenticated;
drop policy if exists "Weekly challenges: read your own" on public.weekly_challenges;
create policy "Weekly challenges: read your own" on public.weekly_challenges
  for select to authenticated using (owner = auth.uid());
drop policy if exists "Weekly challenges: two-step sign-in finished" on public.weekly_challenges;
create policy "Weekly challenges: two-step sign-in finished" on public.weekly_challenges as restrictive
  for all to authenticated using ((select public.mfa_ok())) with check ((select public.mfa_ok()));

-- Weeks since 1970, counting from Mondays (UTC), the same as challengeWeek() in
-- src/accounts/challenges.ts. 1 January 1970 was a Thursday.
create or replace function public.challenge_week()
returns integer
language sql
stable
set search_path = ''
as $$
  select floor((floor(extract(epoch from now()) / 86400) + 3) / 7)::integer;
$$;

-- Pays goal p_slot (0 easy, 1 medium, 2 hard) of week p_week to player p_player.
-- Returns {amount, week, slot}: amount is 0 when that goal was already paid this week.
create or replace function public.claim_challenge(p_player text, p_week integer, p_slot integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  pay integer;
begin
  if me is null then
    raise exception 'Sign in to collect challenge chips.' using errcode = '42501';
  end if;
  if not public.mfa_ok() then
    raise exception 'Finish two-step sign-in first.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.players where id = p_player and owner = me) then
    raise exception 'That player isn''t in your account.' using errcode = '42501';
  end if;
  if p_slot is null or p_slot not between 0 and 2 then
    raise exception 'There''s no such challenge.';
  end if;
  if p_week is distinct from public.challenge_week() then
    raise exception 'That week''s challenges are over. Have a look at the new ones.';
  end if;
  pay := (array[2500, 5000, 10000])[p_slot + 1];
  insert into public.weekly_challenges (owner, week, slot, player_id, amount)
  values (me, p_week, p_slot, p_player, pay)
  on conflict do nothing;
  if not found then
    return jsonb_build_object('amount', 0, 'week', p_week, 'slot', p_slot);
  end if;
  if to_regclass('public.bank_guard') is not null then
    insert into public.bank_guard (owner, allowance) values (me, 100000) on conflict do nothing;
    update public.bank_guard set allowance = public.bank_allowance(bank_guard) + pay, at = now() where owner = me;
  end if;
  return jsonb_build_object('amount', pay, 'week', p_week, 'slot', p_slot);
end;
$$;

revoke all on function public.challenge_week() from public, anon;
revoke all on function public.claim_challenge(text, integer, integer) from public, anon;
grant execute on function public.challenge_week() to authenticated;
grant execute on function public.claim_challenge(text, integer, integer) to authenticated;
