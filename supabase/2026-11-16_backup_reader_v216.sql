-- v216: read-only login used ONLY by the nightly backup (GitHub Actions).
-- It can read every table (bypasses RLS so the dump is complete) but cannot
-- change anything. If its password ever leaks, nobody can edit or delete data.
--
-- Before running: replace CHANGE_ME_STRONG_PASSWORD with a long random password
-- (letters + numbers only, 24+ characters, no @ : / ? # %). Keep it only in the
-- GitHub secret SUPABASE_BACKUP_DB_URL. Run once in Supabase → SQL Editor.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gramg_backup') then
    create role gramg_backup login bypassrls connection limit 3
      password 'CHANGE_ME_STRONG_PASSWORD';
  else
    alter role gramg_backup login bypassrls connection limit 3
      password 'CHANGE_ME_STRONG_PASSWORD';
  end if;
end $$;

grant pg_read_all_data to gramg_backup;
alter role gramg_backup set default_transaction_read_only = on;
alter role gramg_backup set statement_timeout = '15min';

-- Check: should show gramg_backup | t | t
select r.rolname, r.rolbypassrls,
       pg_has_role('gramg_backup', 'pg_read_all_data', 'member') as can_read_all
from pg_roles r where r.rolname = 'gramg_backup';
