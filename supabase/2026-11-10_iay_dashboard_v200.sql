-- =====================================================================
-- G RAM-G 4A — IAY Dashboard for the admin panel's first page (v200, 2026-11-10)
-- One call gives the whole picture for what the login may see:
--   gp_admin → own GP only (private.iay_scope), super_admin → all GPs or one GP.
-- 90-day progress (works by MRs done, mandays ≈ completed MRs × 15 vs works × 90),
-- wagelist (MRs WL Generated / filled waiting for WL), MB pages and K-Desk jobs,
-- and a breakdown: village-wise for one GP, GP-wise for the block.
-- Requires v199. Safe to run again.
-- =====================================================================

create or replace function public.iay_dashboard(p_jc_prefix text default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope();
  v_p text := coalesce(v_scope, p_jc_prefix);
  v_t date := private.iay_today();
  v_out jsonb;
begin
  with s as (select * from private.iay_state(v_p)),
  w as (select x.*, wk.work_status, coalesce(nullif(trim(wk.village), ''), '—') vill
          from s x join public.iay_works wk on wk.work_code = x.work_code),
  m as (select r.work_code, r.status, r.end_date, w.jc_prefix, w.gp_name, w.vill
          from public.iay_mrs r join w on w.work_code = r.work_code),
  per as (
    select w.work_code, w.jc_prefix, w.gp_name, w.vill, w.n_eff, w.next_start, w.work_status,
           count(m.*) filter (where m.status in ('Filled', 'WL Generated')) mr_done,
           count(m.*) filter (where m.status = 'WL Generated') mr_wl,
           count(m.*) filter (where m.status = 'Filled') mr_wait,
           count(m.*) filter (where m.end_date <= v_t and coalesce(m.status, '') not in ('Filled', 'WL Generated', 'Zero')) mr_pend,
           count(m.*) filter (where m.status = 'Running') mr_run
      from w left join m on m.work_code = w.work_code
     group by 1, 2, 3, 4, 5, 6, 7),
  brk as (
    select case when v_p is null then gp_name else vill end name,
           case when v_p is null then jc_prefix end jc,
           count(*) works, round(avg(n_eff), 1) avg_mrs,
           count(*) filter (where n_eff >= 6) done6,
           count(*) filter (where n_eff = 0) no_mr,
           sum(mr_pend) pend, count(*) filter (where next_start <= v_t) gap,
           sum(mr_wait) wl_wait, sum(mr_wl) wl_done, sum(mr_done) mr_done
      from per group by 1, 2),
  rep as (select min(report_at) oldest, max(report_at) newest
            from (select distinct on (jc_prefix) jc_prefix, report_at from public.iay_imports
                   where v_p is null or jc_prefix = v_p order by jc_prefix, at desc) z)
  select jsonb_build_object(
    'today', v_t, 'scope', v_scope, 'prefix', v_p,
    'report_oldest', (select oldest from rep), 'report_newest', (select newest from rep),
    'works', (select count(*) from per),
    'ongoing', (select count(*) from per where work_status = 'Ongoing'),
    'approved', (select count(*) from per where work_status = 'Approved'),
    'dist', (select jsonb_agg(coalesce((select count(*) from per where least(n_eff, 6) = k), 0) order by k) from generate_series(0, 6) k),
    'mr_done', (select coalesce(sum(mr_done), 0) from per),
    'mr_wl', (select coalesce(sum(mr_wl), 0) from per),
    'mr_wait', (select coalesce(sum(mr_wait), 0) from per),
    'mr_pend', (select coalesce(sum(mr_pend), 0) from per),
    'mr_run', (select coalesce(sum(mr_run), 0) from per),
    'mr_gap', (select count(*) from per where next_start <= v_t),
    'done6', (select count(*) from per where n_eff >= 6),
    'breakdown', coalesce((select jsonb_agg(to_jsonb(b) order by b.pend desc, b.name) from brk b), '[]'::jsonb),
    'mb', case when v_p is null then null else (
      select jsonb_build_object('first_mb', st.first_mb, 'last_mb', st.last_mb, 'pages_per_mb', st.pages_per_mb, 'pages_per_work', st.pages_per_work,
               'slots', (select count(*) from public.iay_mb_allot a where a.jc_prefix = v_p),
               'last_used', (select max(mb_no) from public.iay_mb_allot a where a.jc_prefix = v_p),
               'waiting', (select count(*) from per where work_status = 'Ongoing'
                             and not exists (select 1 from public.iay_mb_allot a where a.work_code = per.work_code)))
        from public.iay_mb_settings st where st.jc_prefix = v_p) end,
    'jobs', (select jsonb_build_object(
               'open', count(*) filter (where status in ('queued', 'running')),
               'queued', count(*) filter (where status = 'queued'),
               'today_ok', coalesce(sum(ok) filter (where (updated_at at time zone 'Asia/Kolkata')::date = v_t), 0),
               'today_err', coalesce(sum(failed) filter (where (updated_at at time zone 'Asia/Kolkata')::date = v_t), 0),
               'by_kind', (select jsonb_object_agg(k, n) from (select kind k, sum(ok) n from public.iay_jobs
                             where (v_p is null or jc_prefix = v_p) and (updated_at at time zone 'Asia/Kolkata')::date = v_t group by kind) q))
             from public.iay_jobs where v_p is null or jc_prefix = v_p)
  ) into v_out;
  return v_out;
end $$;

revoke all on function public.iay_dashboard(text) from public, anon;
grant execute on function public.iay_dashboard(text) to authenticated;

select 'OK: IAY dashboard installed' as result;
