-- =====================================================================
-- v238 · MR stage order: e-MB + AE verify come BEFORE MR fill (non-PBA works)
--   Koushik's rule: for normal works the e-MB entry and AE verification are done first,
--   only then can the Master Roll be filled, then the wage list.
--     Normal works:  Running → e-MB entry ('emb') → AE verify ('verify') → MR fill → WL
--     PBA (/IAY/):   Running → MR fill → WL   (no e-MB in the MR report; unchanged)
--   Before v238 every unfilled MR without e-MB counted as "MR fill pending", and an unfilled
--   MR whose e-MB was already verified counted as "WL pending".
--   private.mr_stage is the one place that decides the stage for Report (report_home,
--   report_mrs, report_works) and Admin (admin_pipeline_mrs → Today + 💸 Pipeline),
--   so this one change fixes all of them. Stage names are the same as before.
--   Still a plain inlinable expression (no SET search_path, see v233).
-- Supabase dashboard → SQL Editor → paste all → Run. Safe to run twice.
-- =====================================================================
begin;

create or replace function private.mr_stage(r public.pipeline_mrs, p_today date)
 returns text language sql stable as $function$
  select case
    when r.zero then 'zero'
    when coalesce(r.wl_no, '') <> '' or coalesce(r.wl_date, '') <> '' then 'wl_done'
    when not r.filled and r.date_to is not null and r.date_to > p_today then 'running'
    -- PBA: no e-MB step
    when r.work_code operator(pg_catalog.~*) '/IAY/' then
      case when r.filled then 'wl_pending' when r.date_to = p_today then 'fill_today' else 'fill_pending' end
    -- normal works: e-MB entry → AE verify → MR fill → WL
    when r.meas_date is null then 'emb'
    when r.verif_date is null then 'verify'
    when not r.filled then case when r.date_to = p_today then 'fill_today' else 'fill_pending' end
    else 'wl_pending' end
$function$;

select private.schema_mark(238, 'MR stage: e-MB + AE verify before MR fill (normal works)');

commit;

notify pgrst, 'reload schema';
