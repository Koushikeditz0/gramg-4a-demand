#!/usr/bin/env bash
# Gram Setu restore drill.
# Takes the newest backup from R2 (or a local file), decrypts it, restores it
# into the TEST Supabase project and checks that every table came back with
# the same number of rows. It never touches the live database.
#
# The repo is public, so this script prints only table names, counts and
# OK/mismatch — never data, URLs or keys.
#
# Needed environment:
#   TEST_DB_URL         postgres URI of the TEST project (user postgres, session pooler, port 5432)
#   AGE_KEY             the age private key (AGE-SECRET-KEY-...) — the whole line
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET   (unless BACKUP_FILE is given)
# Optional:
#   BACKUP_FILE         a local .tar.age file instead of the newest one in R2
#   BACKUP_NAME         a file name in R2 daily/ (default: newest)
#   LIVE_REF            live project ref that must never be the target (default wbzybizfpdalpukfzefk)
set -euo pipefail
umask 077

LIVE_REF="${LIVE_REF:-wbzybizfpdalpukfzefk}"
: "${TEST_DB_URL:?TEST_DB_URL missing (GitHub secret TEST_DB_URL)}"
: "${AGE_KEY:?AGE_KEY missing (GitHub secret BACKUP_AGE_KEY)}"

# ---- safety: the target must not be the live database ----
case "$TEST_DB_URL" in
  *"$LIVE_REF"*) echo "STOP: TEST_DB_URL points to the LIVE project. Nothing was done."; exit 1;;
  postgres://*|postgresql://*) ;;
  *) echo "TEST_DB_URL must start with postgresql://"; exit 1;;
esac
case "$AGE_KEY" in AGE-SECRET-KEY-1*) ;; *) echo "BACKUP_AGE_KEY does not look like an age private key (AGE-SECRET-KEY-1...)"; exit 1;; esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export PGCONNECT_TIMEOUT=30
PSQL=(psql "$TEST_DB_URL" -X -q -v ON_ERROR_STOP=1 -A -t)
clean() { sed -E 's#postgres(ql)?://[^ ]*#<db-url>#g' | { grep -vE '^(DETAIL|CONTEXT|HINT|LINE|QUERY)' || true; } | { grep -v '^\s*$' || true; }; }

# ---- 1. get the backup ----
echo "1/6 Getting the backup…"
if [ -n "${BACKUP_FILE:-}" ]; then
  cp "$BACKUP_FILE" "$WORK/backup.tar.age"; NAME="$(basename "$BACKUP_FILE")"
else
  : "${R2_ACCOUNT_ID:?}"; : "${R2_ACCESS_KEY_ID:?}"; : "${R2_SECRET_ACCESS_KEY:?}"; : "${R2_BUCKET:?}"
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  S3=(aws s3 --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com")
  NAME="${BACKUP_NAME:-}"
  if [ -z "$NAME" ]; then
    NAME=$({ "${S3[@]}" ls "s3://$R2_BUCKET/daily/" || true; } | awk '{print $4}' | { grep -E '^gramsetu_.*\.tar\.age$' || true; } | sort | tail -n 1)
  fi
  [ -n "$NAME" ] || { echo "No backup found in R2 daily/"; exit 1; }
  "${S3[@]}" cp --only-show-errors "s3://$R2_BUCKET/daily/$NAME" "$WORK/backup.tar.age"
fi
echo "   backup: $NAME"

# ---- 2. decrypt ----
echo "2/6 Decrypting…"
printf '%s\n' "$AGE_KEY" > "$WORK/key.txt"
age -d -i "$WORK/key.txt" -o "$WORK/backup.tar" "$WORK/backup.tar.age" 2>/dev/null \
  || { echo "Could not decrypt: BACKUP_AGE_KEY is not the key that matches BACKUP_AGE_RECIPIENT"; exit 1; }
rm -f "$WORK/key.txt" "$WORK/backup.tar.age"
mkdir "$WORK/x"; tar -C "$WORK/x" -xf "$WORK/backup.tar"; rm -f "$WORK/backup.tar"
DIR="$(find "$WORK/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -f "$DIR/app.dump" ] && [ -f "$DIR/auth.dump" ] || { echo "Backup is missing app.dump/auth.dump"; exit 1; }
COUNTS_KIND=$(sed -n 's/^row_counts=//p' "$DIR/manifest.txt" 2>/dev/null || true); COUNTS_KIND="${COUNTS_KIND:-estimate}"
echo "   $(grep -E '^(created_ist|app_tables|auth_tables)=' "$DIR/manifest.txt" | tr '\n' ' ')"

# ---- 3. empty the test project ----
echo "3/6 Emptying the TEST project (old drill data)…"
"${PSQL[@]}" >"$WORK/prep.log" 2>&1 <<'SQL' || { echo "Could not prepare the TEST project:"; clean < "$WORK/prep.log" | head -n 20; exit 1; }
set client_min_messages = warning;
drop schema if exists private cascade;
do $$ declare r record; begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r','p','v','m','S','f') loop
    execute format('drop %s if exists public.%I cascade',
      case (select relkind from pg_class where relname = r.relname and relnamespace = 'public'::regnamespace)
        when 'v' then 'view' when 'm' then 'materialized view' when 'S' then 'sequence' when 'f' then 'foreign table' else 'table' end,
      r.relname);
  end loop;
  for r in select p.oid::regprocedure as sig, p.prokind from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('drop %s if exists %s cascade', case when r.prokind = 'p' then 'procedure' else 'function' end, r.sig);
  end loop;
  for r in select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public' and t.typtype in ('e','d','c')
             and not exists (select 1 from pg_class c where c.reltype = t.oid) loop
    execute format('drop type if exists public.%I cascade', r.typname);
  end loop;
end $$;
delete from auth.identities;
delete from auth.users;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
SQL

# ---- 4. restore: logins first (app tables point at auth.users), then app ----
echo "4/6 Restoring logins…"
pg_restore --no-owner --data-only -d "$TEST_DB_URL" "$DIR/auth.dump" 2>"$WORK/e_auth" || true
AUTH_ERR=$(grep -c 'ERROR' "$WORK/e_auth" || true)
echo "5/6 Restoring app data (tables, functions, rows)…"
pg_restore --no-owner -d "$TEST_DB_URL" "$DIR/app.dump" 2>"$WORK/e_app" || true
# "schema public already exists" is normal on a Supabase project: ignore it.
APP_ERR=$(grep 'ERROR' "$WORK/e_app" | grep -vc 'schema "public" already exists' || true)
echo "   restore messages: logins $AUTH_ERR error(s), app $APP_ERR error(s)"
if [ "$((AUTH_ERR + APP_ERR))" -gt 0 ]; then
  echo "   first errors (data removed):"
  cat "$WORK/e_auth" "$WORK/e_app" | grep 'ERROR' | { grep -v 'schema "public" already exists' || true; } | clean | sed -E 's/^pg_restore: //' | sort | uniq -c | sort -rn | head -n 15 | sed 's/^/     /'
fi

# ---- 6. compare row counts ----
echo "6/6 Comparing row counts (backup → test copy, counts were: $COUNTS_KIND)…"
OK=0; BAD=0; MISSING=0; TOTAL=0
while IFS=$'\t' read -r tbl want; do
  [ -n "$tbl" ] || continue
  case "$tbl" in public.*|private.*|auth.users|auth.identities) ;; *) continue;; esac
  TOTAL=$((TOTAL + 1))
  sch="${tbl%%.*}"; t="${tbl#*.}"
  got=$("${PSQL[@]}" -c "select count(*) from \"$sch\".\"$t\"" 2>/dev/null || echo "x")
  if [ "$got" = "x" ]; then MISSING=$((MISSING + 1)); echo "   ✗ $tbl: table not restored"; continue; fi
  want="${want:-0}"; [ "$want" -lt 0 ] 2>/dev/null && want=0
  if [ "$COUNTS_KIND" = "exact" ]; then
    if [ "$got" = "$want" ]; then OK=$((OK + 1)); else BAD=$((BAD + 1)); echo "   ✗ $tbl: backup $want, restored $got"; fi
  else
    # old backups only stored Postgres' estimate: allow 2% (+5 rows) difference
    diff=$(( got > want ? got - want : want - got )); lim=$(( want / 50 + 5 ))
    if [ "$diff" -le "$lim" ]; then OK=$((OK + 1)); else BAD=$((BAD + 1)); echo "   ✗ $tbl: backup ≈$want, restored $got"; fi
  fi
done < "$DIR/row_counts.tsv"
FUNCS=$("${PSQL[@]}" -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')")
VER=$("${PSQL[@]}" -c "select coalesce(max(version)::text, '-') from public.schema_versions" 2>/dev/null || echo "-")

echo ""
echo "RESULT: $OK of $TOTAL tables match, $BAD different, $MISSING missing · $FUNCS functions · DB version v$VER"
if [ "$TOTAL" -lt 10 ] || [ "$BAD" -gt 0 ] || [ "$MISSING" -gt 0 ]; then
  echo "::error::Restore drill FAILED — the backup could not be fully restored. See the lines marked ✗ above."
  exit 1
fi
echo "✅ Restore drill passed: backup $NAME can be restored."
