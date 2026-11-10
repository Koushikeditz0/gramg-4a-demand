-- =====================================================================
-- G RAM-G 4A — IAY "all works" table for the admin panel's IAY section (v201, 2026-11-10)
-- One row per work of ONE GP: Job Card, beneficiary, work code, status, MB No + first page,
-- every phase's MR (No, From–To, portal status) and the wagelist details.
-- GP Admin: always their own GP. Super Admin: must name a GP (the block is too big for one table).
-- Requires v199 (MB allotment). Safe to run again.
-- =====================================================================

create or replace function public.iay_works_full(p_jc_prefix text default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope();
  v_p text := coalesce(v_scope, p_jc_prefix);
begin
  if v_p is null then raise exception 'PICK_ONE_GP'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'wc', s.work_code, 'jcn', s.jcn, 'name', s.ben_name, 'reg', s.reg_no,
             'vill', coalesce(nullif(trim(w.village), ''), '—'), 'st', w.work_status,
             'n', s.n_eff, 'left', s.remaining, 'next', s.next_start, 'last', s.last_end,
             'mb', a.mb_no, 'pg', a.page_from,
             'wl', w.wl_info, 'wlno', w.wl_no, 'wld', w.wl_date,
             'mrs', coalesce((select jsonb_agg(jsonb_build_object('q', r.seq, 'no', r.mr_no, 'f', r.start_date, 't', r.end_date, 's', r.status)
                                               order by r.start_date, r.mr_no)
                                from public.iay_mrs r where r.work_code = s.work_code), '[]'::jsonb))
           order by case when s.jcn ~ '^WB-\d{2}-\d{3}-\d{3}-\d{3}/\d+' then substring(s.jcn from 15 for 3)::int end,
                    case when s.jcn ~ '/\d+' then substring(s.jcn from '/(\d+)')::int end, s.jcn, s.work_code)
      from private.iay_state(v_p) s
      join public.iay_works w on w.work_code = s.work_code
      left join public.iay_mb_allot a on a.work_code = s.work_code), '[]'::jsonb);
end $$;

revoke all on function public.iay_works_full(text) from public, anon;
grant execute on function public.iay_works_full(text) to authenticated;

select 'OK: IAY works table installed' as result;
