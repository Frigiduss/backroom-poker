#!/bin/sh
# Runs the supabase/*.sql files against a throwaway local Postgres (with a stand-in for
# Supabase's auth schema), then test/sql/policies.sql, which checks the row rules, two-step
# sign-in and the chip bank limits. Needs a Postgres server you can reach with psql as a
# superuser, for example: PGHOST=/tmp PGPORT=5499 PGUSER=postgres sh test/sql/run.sh
set -e
cd "$(dirname "$0")/../.."
psql -q -v ON_ERROR_STOP=1 -d postgres -c 'drop database if exists brp_sql_test' -c 'create database brp_sql_test'
for f in test/sql/auth-stub.sql supabase/setup.sql supabase/admin.sql supabase/multiplayer.sql supabase/achievements.sql supabase/leaderboard.sql supabase/security.sql supabase/banks.sql; do
  psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f "$f" 2>&1 | grep -v NOTICE || true
done
psql -q -v ON_ERROR_STOP=1 -d brp_sql_test -f test/sql/policies.sql 2>&1 | grep -E 'ok:|FAIL|ERROR'
