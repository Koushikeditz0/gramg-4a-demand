#!/usr/bin/env bash
# Gram Setu nightly Supabase backup.
# Dumps the database, encrypts it with age (public key only) and uploads it
# to a private Cloudflare R2 bucket. Nothing readable ever leaves this runner:
# the repo is public, so this script never prints data, URLs or keys.
#
# Needed environment:
#   DB_URL              postgres URI of the read-only backup user (session pooler, port 5432)
#   AGE_RECIPIENT       age public key (age1...). The private key stays only with Koushik.
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
# Optional:
#   KEEP_DAILY (30), KEEP_MONTHLY (12), SKIP_UPLOAD=1 (local test), OUT_DIR
set -euo pipefail
umask 077

# Simplest setup: only the password secret. User + pooler host are fixed here
# (not secret). A full DB_URL secret still works when no password secret is set.
POOLER_URL="postgresql://gramg_backup.wbzybizfpdalpukfzefk@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
if [ -n "${DB_PASSWORD:-}" ]; then
  DB_URL="$POOLER_URL"; export PGPASSWORD="$DB_PASSWORD"
  echo "Using SUPABASE_BACKUP_PASSWORD (user gramg_backup, session pooler)"
fi
: "${DB_URL:?DB_URL missing}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT missing}"
case "$AGE_RECIPIENT" in age1*) ;; *) echo "AGE_RECIPIENT must be an age public key (age1...)"; exit 1;; esac
if [ "${SKIP_UPLOAD:-0}" != "1" ] && [ -z "${R2_ACCOUNT_ID:-}" ]; then
  echo "R2_ACCOUNT_ID is empty: add it as a GitHub secret or variable named exactly R2_ACCOUNT_ID"; exit 1
fi
KEEP_DAILY="${KEEP_DAILY:-30}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"

STAMP_DAY="$(TZ=Asia/Kolkata date +%F)"          # 2026-11-16 (IST)
STAMP_TIME="$(TZ=Asia/Kolkata date +%F_%H%M)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DIR="$WORK/gramsetu-backup-$STAMP_TIME"
mkdir -p "$DIR"

export PGCONNECT_TIMEOUT=30
PGOPTS=(--no-owner --format=custom --compress=9)

echo "1/5 App data (public + private schemas)…"
pg_dump "$DB_URL" "${PGOPTS[@]}" --schema=public --schema=private \
        --file="$DIR/app.dump" 2>"$WORK/err1" || { echo "pg_dump app failed"; sed -E 's#postgres(ql)?://[^ ]*#<db-url>#g' "$WORK/err1"; exit 1; }

echo "2/5 Logins (auth.users + auth.identities, data only)…"
pg_dump "$DB_URL" "${PGOPTS[@]}" --data-only \
        --table=auth.users --table=auth.identities \
        --file="$DIR/auth.dump" 2>"$WORK/err2" || { echo "pg_dump auth failed"; sed -E 's#postgres(ql)?://[^ ]*#<db-url>#g' "$WORK/err2"; exit 1; }

echo "3/5 Checking the dumps…"
APP_TABLES=$(pg_restore --list "$DIR/app.dump" | grep -c ' TABLE DATA ' || true)
AUTH_TABLES=$(pg_restore --list "$DIR/auth.dump" | grep -c ' TABLE DATA ' || true)
if [ "$APP_TABLES" -lt 10 ] || [ "$AUTH_TABLES" -lt 2 ]; then
  echo "Dump looks incomplete (app tables: $APP_TABLES, auth tables: $AUTH_TABLES)"; exit 1
fi
# Exact row counts go INSIDE the encrypted file only. The restore drill
# (restore-drill.sh) compares them with the restored copy.
COUNTS=exact
psql "$DB_URL" -X -q -A -t -F $'\t' -c "
  select t.table_schema||'.'||t.table_name,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text
  from information_schema.tables t
  where t.table_type = 'BASE TABLE'
    and (t.table_schema in ('public','private') or (t.table_schema = 'auth' and t.table_name in ('users','identities')))
  order by 1" > "$DIR/row_counts.tsv" 2>/dev/null || {
  COUNTS=estimate
  psql "$DB_URL" -X -q -A -t -F $'\t' -c "
    select schemaname||'.'||relname, n_live_tup
    from pg_stat_user_tables where schemaname in ('public','auth')
    order by 1" > "$DIR/row_counts.tsv" 2>/dev/null || { COUNTS=none; echo "(row counts skipped)"; }
}
{
  echo "created_ist=$STAMP_TIME"
  echo "pg_dump=$(pg_dump --version)"
  echo "app_tables=$APP_TABLES"
  echo "auth_tables=$AUTH_TABLES"
  echo "row_counts=$COUNTS"
} > "$DIR/manifest.txt"

echo "4/5 Encrypting…"
OUT_NAME="gramsetu_${STAMP_TIME}.tar.age"
tar -C "$WORK" -cf - "$(basename "$DIR")" | age -r "$AGE_RECIPIENT" -o "$WORK/$OUT_NAME"
rm -rf "$DIR"
SIZE=$(stat -c %s "$WORK/$OUT_NAME")
echo "   encrypted file: $OUT_NAME ($((SIZE/1024)) KB), $APP_TABLES app tables, $AUTH_TABLES auth tables"
if [ "$SIZE" -lt 20000 ]; then echo "Encrypted file too small, something is wrong"; exit 1; fi

if [ "${SKIP_UPLOAD:-0}" = "1" ]; then
  mkdir -p "${OUT_DIR:-.}"; cp "$WORK/$OUT_NAME" "${OUT_DIR:-.}/"
  echo "SKIP_UPLOAD=1 → saved locally only"; exit 0
fi

: "${R2_ACCOUNT_ID:?}"; : "${R2_ACCESS_KEY_ID:?}"; : "${R2_SECRET_ACCESS_KEY:?}"; : "${R2_BUCKET:?}"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
S3=(aws s3 --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com")

echo "5/5 Uploading to R2…"
"${S3[@]}" cp --only-show-errors "$WORK/$OUT_NAME" "s3://$R2_BUCKET/daily/$OUT_NAME"
if [ "$(TZ=Asia/Kolkata date +%d)" = "01" ] || [ "${FORCE_MONTHLY:-0}" = "1" ]; then
  "${S3[@]}" cp --only-show-errors "$WORK/$OUT_NAME" "s3://$R2_BUCKET/monthly/$OUT_NAME"
  echo "   also kept as monthly copy"
fi

# Retention: keep the newest KEEP_DAILY daily files and KEEP_MONTHLY monthly files.
prune() {
  local prefix="$1" keep="$2"
  { "${S3[@]}" ls "s3://$R2_BUCKET/$prefix/" 2>/dev/null || true; } | awk '{print $4}' | { grep -E '^gramsetu_.*\.tar\.age$' || true; } | sort -r \
    | tail -n +"$((keep+1))" | while read -r key; do
        "${S3[@]}" rm --only-show-errors "s3://$R2_BUCKET/$prefix/$key"; echo "   removed old $prefix/$key"
      done
}
prune daily "$KEEP_DAILY"
prune monthly "$KEEP_MONTHLY"
echo "Backup done: daily/$OUT_NAME"
