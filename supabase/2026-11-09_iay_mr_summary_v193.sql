-- =====================================================================
-- G RAM-G 4A — IAY Tracker: day-wise MR Summary report (v193, 2026-11-09)
--
--   iay_mr_summary(p_past, p_ahead)  GP x day counts of MRs ending on each day
--                                    (past days + today: total / filled; next days: total)
--   iay_mr_window(p_jc_prefix, p_from, p_to)  the MR rows behind it (for Excel)
-- "Filled" = portal status Filled or WL Generated. Zero MRs are left out.
-- Same scope rules as the other IAY functions. Requires v191. Safe to run again.
-- =====================================================================

create or replace function public.iay_mr_summary(p_past integer default 2, p_ahead integer default 5)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope();
  v_t date := private.iay_today();
  v_past int := least(greatest(coalesce(p_past, 2), 0), 14);
  v_ahead int := least(greatest(coalesce(p_ahead, 5), 0), 14);
begin
  return jsonb_build_object(
    'today', v_t, 'from', v_t - v_past, 'to', v_t + v_ahead,
    'gps', coalesce((
      select jsonb_agg(jsonb_build_object('jc_prefix', g.jc_prefix, 'gp_name', g.gp_name, 'report_at', g.report_at) order by g.gp_name)
        from (select distinct on (i.jc_prefix) i.jc_prefix, i.gp_name, i.report_at
                from public.iay_imports i
               where (v_scope is null or i.jc_prefix = v_scope)
                 and exists (select 1 from public.iay_works w where w.jc_prefix = i.jc_prefix)
               order by i.jc_prefix, i.at desc) g), '[]'::jsonb),
    'cells', coalesce((
      select jsonb_agg(jsonb_build_object('jc_prefix', x.jc_prefix, 'date', x.d, 'total', x.total, 'filled', x.filled))
        from (select w.jc_prefix, r.end_date d, count(*) total,
                     count(*) filter (where r.status in ('Filled', 'WL Generated')) filled
                from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
               where (v_scope is null or w.jc_prefix = v_scope)
                 and r.end_date between v_t - v_past and v_t + v_ahead
                 and coalesce(r.status, '') <> 'Zero'
               group by 1, 2) x), '[]'::jsonb));
end $$;

create or replace function public.iay_mr_window(p_jc_prefix text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); v_p text := coalesce(v_scope, p_jc_prefix);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 31 then raise exception 'BAD_RANGE'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'gp', w.gp_name, 'work_code', w.work_code, 'reg_no', w.reg_no, 'name', w.ben_name, 'jcn', w.jcn,
             'village', w.village, 'mr_no', r.mr_no, 'seq', r.seq, 'start', r.start_date, 'end', r.end_date,
             'status', r.status) order by w.gp_name, r.end_date, r.mr_no)
      from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
     where (v_p is null or w.jc_prefix = v_p)
       and r.end_date between p_from and p_to
       and coalesce(r.status, '') <> 'Zero'), '[]'::jsonb);
end $$;

revoke all on function public.iay_mr_summary(integer, integer), public.iay_mr_window(text, date, date) from public, anon;
grant execute on function public.iay_mr_summary(integer, integer), public.iay_mr_window(text, date, date) to authenticated;

select 'OK: IAY MR summary installed' as result;
