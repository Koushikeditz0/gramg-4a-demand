-- =====================================================================
-- Gram Setu — IAY-busy workers on labour lists (v210, 2026-11-14)
--
-- Problem: supervisors put PBA/IAY house beneficiaries in a labour list,
-- but those workers already have a running IAY MR, so the portal leaves
-- them out of the Demand and the labour count drops.
--
-- This gives the supervisor app (and K-Desk) the IAY works of their own GP
-- that still have MRs now or ahead, from the IAY Tracker data (v191):
--   get_iay_busy()    supervisor (gp_user) — own GP
--   kdesk_iay_busy()  K-Desk login         — own GP
-- works = one short array per IAY work (kept small for phones):
--   [jcn, beneficiary name, last MR end, MRs still to come (rem), [[start,end],...]]
-- MRs listed = those ending today or later (Zero MRs left out). Works whose
-- last MR ended over 7 days ago (stalled) are left out.
-- report_at = time of the GP's last IAY Phase Report import.
-- The app works out the overlap with the list's own dates.
--
-- Read only. New functions only, nothing existing changes.
-- Needs v191. Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create or replace function private.iay_busy_rows(p_prefix text)
returns jsonb language sql stable security definer set search_path to '' as $$
  with t as (select private.iay_today() as d),
  s as (select * from private.iay_state(p_prefix))
  select jsonb_build_object(
    'today', (select d from t),
    'report_at', (select max(i.report_at) from public.iay_imports i where i.jc_prefix = p_prefix),
    'works', coalesce((
      select jsonb_agg(jsonb_build_array(
               s.jcn, s.ben_name, s.last_end, s.remaining,
               (select coalesce(jsonb_agg(jsonb_build_array(r.start_date, r.end_date) order by r.start_date), '[]'::jsonb)
                         from public.iay_mrs r, t
                        where r.work_code = s.work_code and r.end_date >= t.d
                          and coalesce(r.status, '') <> 'Zero')))
        from s, t
       where s.jcn is not null
         and s.last_end is not null
         and (s.last_end >= t.d or (s.remaining > 0 and s.last_end >= t.d - 7))), '[]'::jsonb))
$$;
revoke all on function private.iay_busy_rows(text) from public, anon, authenticated;

create or replace function public.get_iay_busy()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_p text;
begin
  select g.jc_prefix into v_p from public.gram_panchayats g where g.id = v_gp;
  if v_p is null then return jsonb_build_object('works', '[]'::jsonb); end if;
  return private.iay_busy_rows(v_p);
end $$;

create or replace function public.kdesk_iay_busy()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_p text;
begin
  select g.jc_prefix into v_p from public.gram_panchayats g where g.id = v_gp;
  if v_p is null then return jsonb_build_object('works', '[]'::jsonb); end if;
  return private.iay_busy_rows(v_p);
end $$;

revoke all on function public.get_iay_busy(), public.kdesk_iay_busy() from public, anon;
grant execute on function public.get_iay_busy(), public.kdesk_iay_busy() to authenticated;

select 'OK: IAY busy workers (v210) installed' as result;
