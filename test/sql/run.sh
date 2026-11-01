#!/bin/sh
# Runs the supabase/*.sql files against a throwaway local Postgres (with a stand-in for
# Supabase's auth schema), then test/sql/policies.sql, which checks the row rules, two-step
# sign-in and the chip bank limits, and test/sql/crashes.sql for crash reports (then gifts, avatars and push). Needs a Postgres server you can reach with psql as a
# superuser, for example: PGHOST=/tmp PGPORT=5499 PGUSER=postgres sh test/sql/run.sh
set -e
cd "$(dirname "$0")/../.."
psql -q -v ON_ERROR_STOP=1 -d postgres -c 'drop database if exists brp_sql_test' -c 'create database brp_sql_test'
for f in test/sql/auth-stub.sql supabase/setup.sql supabase/admin.sql supabase/multiplayer.sql supabase/achievements.sql supabase/leaderboard.sql supabase/security.sql supabase/banks.sql supabase/friends.sql supabase/crashes.sql supabase/gifts.sql supabase/avatars.sql supabase/push.sql supabase/challenges.sql; do
  psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f "$f" 2>&1 | grep -v NOTICE || true
done
psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f test/sql/policies.sql 2>&1 | grep -E 'ok:|FAIL|ERROR'
psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f test/sql/crashes.sql 2>&1 | grep -E 'ok:|FAIL|ERROR'
psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f test/sql/gifts.sql 2>&1 | grep -E 'ok:|FAIL|ERROR'
psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f test/sql/avatars.sql 2>&1 | grep -E 'ok:|FAIL|ERROR'
psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f test/sql/challenges.sql 2>&1 | grep -E 'ok:|FAIL|ERROR'
psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f test/sql/push.sql 2>&1 | grep -E 'ok:|FAIL|ERROR'
# friends.sql on a project that hasn't set up online tables yet: friends work, invites say why not.
psql -q -v ON_ERROR_STOP=1 -d postgres -c 'drop database if exists brp_sql_min' -c 'create database brp_sql_min'
for f in test/sql/auth-stub.sql supabase/setup.sql supabase/friends.sql; do
  psql -q -v ON_ERROR_STOP=1 -d brp_sql_min -f "$f" 2>&1 | grep -v NOTICE || true
done
psql -q -v ON_ERROR_STOP=1 -d brp_sql_min -f test/sql/friends-minimal.sql 2>&1 | grep -E 'ok:|FAIL|ERROR'
