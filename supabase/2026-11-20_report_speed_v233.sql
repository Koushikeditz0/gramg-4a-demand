-- =====================================================================
-- v233 · Report section (and Admin Pipeline) open faster
--   private.mr_stage(mr, today) decides the stage of every MR (fill / e-MB / verify / WL ...).
--   It had "SET search_path", which stops Postgres from inlining it, so it ran as a separate
--   function call for every MR row: 20,800 MRs ≈ 190 ms per pass. report_home makes 2 passes
--   per GP (≈ 0.6–1.5 s); report_mrs, report_works and admin_pipeline_mrs call it too.
--   Now it is a plain inlinable expression (same rules, same answer): ≈ 15 ms per pass.
--   It reads only the MR row it is given (no table), and the one operator is written as
--   pg_catalog.~*, so it does not depend on the search_path.
-- Supabase dashboard → SQL Editor → paste all → Run. Safe to run twice.
-- =====================================================================
begin;

create or replace function private.mr_stage(r public.pipeline_mrs, p_today date)
 returns text language sql stable as $function$
  select case
    when r.zero then 'zero'
    when coalesce(r.wl_no, '') <> '' or coalesce(r.wl_date, '') <> '' then 'wl_done'
    when not r.filled and r.meas_date is null then
      case when r.date_to is null then 'fill_pending' when r.date_to > p_today then 'running'
           when r.date_to = p_today then 'fill_today' else 'fill_pending' end
    when r.work_code operator(pg_catalog.~*) '/IAY/' then 'wl_pending'
    when r.meas_date is null then 'emb'
    when r.verif_date is null then 'verify'
    else 'wl_pending' end
$function$;

select private.schema_mark(233, 'Report + Pipeline faster (MR stage inlined)');

commit;

notify pgrst, 'reload schema';
