-- =====================================================================
-- G RAM-G 4A List Builder — clean up old import staging rows (2026-10-25)
-- The Excel import keeps a working copy of every row (import_staging_rows).
-- After an import is committed / rolled back / cancelled that copy is never
-- used again (rollback uses worker history, not this copy), but it was kept.
--   * deletes the copy of every finished import now
--   * from now on, deletes it automatically whenever a new import starts
-- An import still in Preview ("staged") is never touched.
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create or replace function private.cleanup_import_staging()
returns integer language plpgsql security definer set search_path to '' as $function$
declare v_n integer;
begin
  delete from public.import_staging_rows s
   using public.import_jobs j
   where j.id = s.import_job_id and j.status <> 'staged';
  get diagnostics v_n = row_count;
  return v_n;
end $function$;
revoke all on function private.cleanup_import_staging() from public, anon, authenticated;

create or replace function private.trg_import_jobs_cleanup()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  perform private.cleanup_import_staging();
  return null;
end $function$;
revoke all on function private.trg_import_jobs_cleanup() from public, anon, authenticated;

drop trigger if exists import_jobs_cleanup_staging on public.import_jobs;
create trigger import_jobs_cleanup_staging
  after insert on public.import_jobs
  for each statement execute function private.trg_import_jobs_cleanup();

select 'OK: removed ' || private.cleanup_import_staging() || ' old staging rows' as result;

-- Optional, to give the freed space back right away: run this ONE line on its own afterwards
-- (Postgres also reuses the space by itself over time):
--   vacuum full public.import_staging_rows;
