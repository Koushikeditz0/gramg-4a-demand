-- =====================================================================
-- G RAM-G 4A List Builder: clean up import staging rows right after an import
-- finishes (v208, 2026-11-13). Already run from Claude via Supabase MCP.
-- Before: the copy was only deleted when the NEXT import started, so the
-- last import's rows (e.g. 10,793 rows of GP 3) stayed in the database.
-- Now: also deleted as soon as an import's status leaves 'staged'
-- (committed / rolled back / cancelled). Imports in Preview are never touched.
-- Safe to run again.
-- =====================================================================
create or replace function private.trg_import_jobs_status_cleanup()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if new.status is distinct from old.status and new.status <> 'staged' then
    delete from public.import_staging_rows where import_job_id = new.id;
  end if;
  return null;
end $function$;
revoke all on function private.trg_import_jobs_status_cleanup() from public, anon, authenticated;

drop trigger if exists import_jobs_cleanup_on_finish on public.import_jobs;
create trigger import_jobs_cleanup_on_finish
  after update of status on public.import_jobs
  for each row execute function private.trg_import_jobs_status_cleanup();

select 'OK: removed ' || private.cleanup_import_staging() || ' old staging rows' as result;
