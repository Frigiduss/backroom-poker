-- Back Room Poker: crash reports for the admin dashboard.
-- Run this once, after admin.sql (it needs is_admin() from there), in the SQL Editor (New query → paste → Run).
-- Running it again is safe. It adds:
--   * crash_reports   errors players hit, grouped: the same error from many players is one row with a count
--   * report_crash()  the only way in. Anyone playing can call it, signed in or not, so it trims every
--                     field, limits how often one connection, one account and everybody together can
--                     report, and keeps at most 500 rows (the oldest go first)
-- Only admins can read reports, mark them fixed, or delete them.

create table if not exists public.crash_reports (
  id bigint generated always as identity primary key,
  -- what makes two reports "the same error": the message and the first line of the stack
  fingerprint text not null unique,
  message text not null,
  stack text not null default '',
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  count integer not null default 1,
  -- where it happened, a few distinct values each
  games text[] not null default '{}',
  browsers text[] not null default '{}',
  builds text[] not null default '{}',
  -- the most recent signed-in account that hit it (none for signed-out players)
  account uuid references auth.users (id) on delete set null,
  -- people it happened to: signed-in accounts and signed-out connections, counted once each
  people integer not null default 1,
  seen_by text[] not null default '{}',
  -- an admin marked it fixed; it opens again if it happens after that
  fixed_at timestamptz
);

create index if not exists crash_reports_last_at on public.crash_reports (last_at desc);

alter table public.crash_reports enable row level security;
drop policy if exists "Crashes: admin can read" on public.crash_reports;
drop policy if exists "Crashes: admin can mark fixed" on public.crash_reports;
drop policy if exists "Crashes: admin can delete" on public.crash_reports;
create policy "Crashes: admin can read" on public.crash_reports
  for select to authenticated using ((select public.is_admin()));
create policy "Crashes: admin can mark fixed" on public.crash_reports
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "Crashes: admin can delete" on public.crash_reports
  for delete to authenticated using ((select public.is_admin()));
revoke all on public.crash_reports from anon, authenticated;
grant select, delete on public.crash_reports to authenticated;
grant update (fixed_at) on public.crash_reports to authenticated;

-- How many reports each sender has made in the current hour. Nobody reads it but report_crash().
create table if not exists public.crash_budget (
  bucket text primary key,
  window_start timestamptz not null default now(),
  used integer not null default 0
);
alter table public.crash_budget enable row level security;
revoke all on public.crash_budget from anon, authenticated;

-- A random secret, made here and never sent anywhere, so the connection ids kept above can't be
-- turned back into IP addresses.
create table if not exists public.crash_secret (
  id boolean primary key default true check (id),
  salt text not null default gen_random_uuid()::text
);
alter table public.crash_secret enable row level security;
revoke all on public.crash_secret from anon, authenticated;
insert into public.crash_secret default values on conflict do nothing;

create or replace function public.report_crash(
  p_message text,
  p_stack text default '',
  p_game text default '',
  p_browser text default '',
  p_build text default ''
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  headers json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  ip text := coalesce(nullif(headers ->> 'cf-connecting-ip', ''), nullif(trim(split_part(headers ->> 'x-forwarded-for', ',', 1)), ''), 'unknown');
  salt text := (select s.salt from public.crash_secret s);
  conn text := 'ip:' || md5(coalesce(salt, '') || ip);
  who text := coalesce('u:' || auth.uid()::text, conn);
  msg text := left(regexp_replace(coalesce(p_message, ''), '[[:cntrl:]]+', ' ', 'g'), 300);
  stk text := left(coalesce(p_stack, ''), 2000);
  game text := left(regexp_replace(coalesce(p_game, ''), '[[:cntrl:]]+', ' ', 'g'), 60);
  browser text := left(regexp_replace(coalesce(p_browser, ''), '[[:cntrl:]]+', ' ', 'g'), 60);
  build text := left(regexp_replace(coalesce(p_build, ''), '[^A-Za-z0-9._-]+', '', 'g'), 20);
  frame text;
  fp text;
  n integer;
  hit_id bigint;
begin
  msg := trim(msg);
  if msg = '' then return; end if;

  -- The hourly budgets: this connection, this account, and everybody together. Over budget, the
  -- report is quietly dropped, so a script hammering this gets nothing back to retry against.
  delete from public.crash_budget where window_start < now() - interval '1 hour';
  foreach fp in array array[conn, 'all'] || case when who <> conn then array[who] else '{}'::text[] end loop
    insert into public.crash_budget as b (bucket, window_start, used) values (fp, now(), 1)
    on conflict (bucket) do update set used = b.used + 1
    returning used into n;
    if n > (case when fp = 'all' then 600 else 30 end) then return; end if;
  end loop;

  -- The first stack frame: "    at fn (url:1:2)" in Chrome, "fn@url:1:2" in Firefox and Safari.
  frame := coalesce(trim((regexp_match(stk, '(?n)^([^\n]*(?:\sat\s|@)[^\n]*)$'))[1]), '');
  fp := md5(msg || chr(10) || frame);
  select id into hit_id from public.crash_reports where fingerprint = fp for update;
  if hit_id is not null then
    update public.crash_reports set
      last_at = now(),
      count = count + 1,
      stack = case when stk <> '' then stk else stack end,
      games = case when game = '' or game = any(games) or cardinality(games) >= 8 then games else games || game end,
      browsers = case when browser = '' or browser = any(browsers) or cardinality(browsers) >= 8 then browsers else browsers || browser end,
      builds = case when build = '' or build = any(builds) then builds else (builds || build)[greatest(1, cardinality(builds) - 3):] end,
      account = coalesce(auth.uid(), account),
      people = people + case when who = any(seen_by) or cardinality(seen_by) >= 50 then 0 else 1 end,
      seen_by = case when who = any(seen_by) or cardinality(seen_by) >= 50 then seen_by else seen_by || who end,
      fixed_at = null
    where id = hit_id;
    return;
  end if;

  -- A new kind of error. Only so many new ones an hour, so junk can't push real reports out.
  insert into public.crash_budget as b (bucket, window_start, used) values ('new', now(), 1)
  on conflict (bucket) do update set used = b.used + 1
  returning used into n;
  if n > 60 then return; end if;

  insert into public.crash_reports (fingerprint, message, stack, games, browsers, builds, account, seen_by)
  values (fp, msg, stk,
    case when game = '' then '{}' else array[game] end,
    case when browser = '' then '{}' else array[browser] end,
    case when build = '' then '{}' else array[build] end,
    auth.uid(), array[who])
  on conflict (fingerprint) do update set count = public.crash_reports.count + 1, last_at = now();

  delete from public.crash_reports where id in (
    select id from public.crash_reports order by last_at desc offset 500
  );
end;
$$;

revoke all on function public.report_crash(text, text, text, text, text) from public;
grant execute on function public.report_crash(text, text, text, text, text) to anon, authenticated;
