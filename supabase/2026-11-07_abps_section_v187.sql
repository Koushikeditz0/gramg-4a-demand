-- =====================================================================
-- G RAM-G 4A List Builder — ABPS section in the Supervisor app (v187, 2026-11-07)
--
-- get_abps_summary(): per village of the supervisor's GP, how many active
--   workers there are and how many have ABPS / eKYC done.
-- get_abps_village(p_village): the active workers of one village whose ABPS
--   or eKYC is NOT done (name, Job Card, flags), so the supervisor can tell them.
-- Read-only. Same GP check as the other supervisor functions.
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create or replace function public.get_abps_summary()
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('village_no', v, 'workers', n, 'abps', a, 'ekyc', e, 'both', b) order by v)
    from (
      select w.village_no as v, count(*) as n,
             count(*) filter (where lower(coalesce(w.abps::text, '')) in ('true','t','yes','y','1')) as a,
             count(*) filter (where lower(coalesce(w.ekyc::text, '')) in ('true','t','yes','y','1')) as e,
             count(*) filter (where lower(coalesce(w.abps::text, '')) in ('true','t','yes','y','1')
                                and lower(coalesce(w.ekyc::text, '')) in ('true','t','yes','y','1')) as b
      from public.workers w
      where w.gp_id = v_gp and w.active
      group by w.village_no) s), '[]'::jsonb);
end $function$;

create or replace function public.get_abps_village(p_village integer)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'worker_id', x.id, 'job_card_no', x.job_card_no, 'applicant_no', x.applicant_no,
             'applicant_name', x.applicant_name, 'household_no', x.household_no,
             'abps', x.ab, 'ekyc', x.ek) order by x.household_no, x.applicant_no)
    from (
      select w.id, w.job_card_no, w.applicant_no, w.applicant_name, w.household_no,
             lower(coalesce(w.abps::text, '')) in ('true','t','yes','y','1') as ab,
             lower(coalesce(w.ekyc::text, '')) in ('true','t','yes','y','1') as ek
      from public.workers w
      where w.gp_id = v_gp and w.active and w.village_no = p_village) x
    where not (x.ab and x.ek)), '[]'::jsonb);
end $function$;

revoke all on function public.get_abps_summary() from public, anon;
revoke all on function public.get_abps_village(integer) from public, anon;
grant execute on function public.get_abps_summary() to authenticated;
grant execute on function public.get_abps_village(integer) to authenticated;

select 'OK: ABPS section installed' as result;
