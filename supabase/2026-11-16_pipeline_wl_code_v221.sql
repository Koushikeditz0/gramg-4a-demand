-- Gram Setu v221 · Payment pipeline: work code of each wage list waiting to be sent,
-- taken from the MR-wise report (R4.2 + R4.4 carries the WL number of every MR).
-- Needs v217 + v220. Safe to run again. Only replaces admin_pipeline_mrs (adds 'wl_code').

create or replace function public.admin_pipeline_mrs(p_gp_id smallint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_t date := private.iay_today(); v_s public.pipeline_mr_syncs%rowtype;
begin
  select * into v_s from public.pipeline_mr_syncs where gp_id = p_gp_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'at', v_s.at, 'source', v_s.source, 'n', v_s.n, 'today', v_t,
    -- MRs still to move (everything except running / zero / wage list done)
    'rows', coalesce((select jsonb_agg(jsonb_build_object('code', m.work_code, 'name', left(m.work_name, 90), 'mr', m.mr_no,
                 'to', m.date_to, 's', private.mr_stage(m, v_t), 'tot', m.total, 'meas', m.meas_date) order by m.date_to, m.work_code)
               from public.pipeline_mrs m
              where m.gp_id = p_gp_id and private.mr_stage(m, v_t) in ('fill_today', 'fill_pending', 'emb', 'verify', 'wl_pending')), '[]'::jsonb),
    'counts', coalesce((select jsonb_object_agg(s, jsonb_build_object('all', n_all, 'pba', n_pba))
               from (select private.mr_stage(m, v_t) s, count(*) n_all, count(*) filter (where m.work_code ~* '/IAY/') n_pba
                       from public.pipeline_mrs m where m.gp_id = p_gp_id group by 1) c), '{}'::jsonb),
    -- v221: work code (+ name) of each wage list on the Send-for-payment list, from the MRs that carry its WL number
    'wl_code', coalesce((select jsonb_object_agg(w.wl, jsonb_build_object('code', w.code, 'name', w.name))
               from (select distinct on (upper(trim(m.wl_no))) upper(trim(m.wl_no)) wl, m.work_code code, left(m.work_name, 90) name
                       from public.pipeline_mrs m
                      where m.gp_id = p_gp_id and m.wl_no ~* '^\s*\d+WL\d+\s*$'
                        and upper(trim(m.wl_no)) in (select upper(i->>'wl') from public.pipeline_snaps s, jsonb_array_elements(s.items) i
                                                      where s.gp_id = p_gp_id and s.kind = 'send_pay')
                      order by upper(trim(m.wl_no)), m.work_code) w), '{}'::jsonb));
end $$;

revoke all on function public.admin_pipeline_mrs(smallint) from public;
grant execute on function public.admin_pipeline_mrs(smallint) to authenticated;

select 'OK: Pipeline wage list work codes from MR report (v221) installed' as result;
