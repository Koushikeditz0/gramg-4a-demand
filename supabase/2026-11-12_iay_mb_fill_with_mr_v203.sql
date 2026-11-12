-- =====================================================================
-- G RAM-G 4A — MB pages also for works that have an MR but are still "Approved" on the portal (v203, 2026-11-12)
-- New MRs were generated for works that had none; the Phase Report keeps them "Approved"
-- until work starts. They now get the next free MB slot (Job Card order among the new ones),
-- like works that become Ongoing. Nobody already allotted moves. Safe to run again.
-- =====================================================================
create or replace function private.iay_mb_fill(p_prefix text)
returns integer language plpgsql security definer set search_path to '' as $$
declare s public.iay_mb_settings%rowtype; v_per int; v_n int;
begin
  select * into s from public.iay_mb_settings where jc_prefix = p_prefix;
  if not found then return 0; end if;
  v_per := s.pages_per_mb / s.pages_per_work;
  with base as (select coalesce(max(sl), 0) m from public.iay_mb_allot where jc_prefix = p_prefix),
  todo as (
    select w.work_code,
           row_number() over (order by
             case when w.jcn ~ '^WB-\d{2}-\d{3}-\d{3}-\d{3}/\d+' then substring(w.jcn from 15 for 3)::int end,
             case when w.jcn ~ '/\d+' then substring(w.jcn from '/(\d+)')::int end,
             w.jcn, w.work_code) rn
      from public.iay_works w
     where w.jc_prefix = p_prefix
       and (w.work_status = 'Ongoing' or exists (select 1 from public.iay_mrs r where r.work_code = w.work_code))
       and not exists (select 1 from public.iay_mb_allot a where a.work_code = w.work_code))
  insert into public.iay_mb_allot (work_code, jc_prefix, sl, mb_no, page_from)
  select t.work_code, p_prefix, b.m + t.rn,
         s.first_mb + (b.m + t.rn - 1) / v_per,
         ((b.m + t.rn - 1) % v_per) * s.pages_per_work + 1
    from todo t cross join base b;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function private.iay_mb_fill(text) from public, anon, authenticated;
select private.iay_mb_fill('WB-08-005-014');
