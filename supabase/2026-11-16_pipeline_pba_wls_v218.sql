-- =====================================================================
-- Gram Setu — Payment pipeline: tell PBA / IAY wage lists apart (v218, 2026-11-16)
--
-- The portal's Send Wagelist For Payment page shows only wage list numbers,
-- no work code. admin_pipeline now also returns 'pba_wls': the wage lists
-- (waiting to be sent, or generated / sent by K-Desk) that are PBA / IAY,
-- found by WL number in
--   • the IAY Tracker (iay_works.wl_no),
--   • ⚖ WL Caste reports taken with "শুধু IAY",
--   • ⚖ WL Caste reports whose MR numbers belong to an IAY work (iay_mrs).
-- Only this one function changes. Needs v217. Safe to run again.
-- =====================================================================

create index if not exists iay_mrs_mrno_idx on public.iay_mrs (mr_no);

create or replace function public.admin_pipeline(p_gp_id smallint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_pre text; v_t date := private.iay_today(); v_codes text[];
        v_lists jsonb; v_iay jsonb; v_snaps jsonb; v_wls jsonb; v_recent jsonb; v_pba jsonb;
begin
  select jc_prefix into v_pre from public.gram_panchayats where id = p_gp_id;

  -- live demand lists with Demand / Allocation results
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.work_name, 'code', l.work_code, 'from', l.from_date, 'days', l.work_days,
      'state', l.submit_state, 'at', coalesce(l.submitted_at, l.created_at),
      'n', s.n, 'd_ok', s.d_ok, 'd_err', s.d_err, 'a_ok', s.a_ok, 'a_err', s.a_err,
      'r_at', s.r_at) order by coalesce(l.submitted_at, l.created_at) desc), '[]'::jsonb),
         coalesce(array_agg(upper(l.work_code)) filter (where l.work_code is not null), '{}')
    into v_lists, v_codes
    from (select * from public.demand_lists where gp_id = p_gp_id and deleted_at is null
           order by coalesce(submitted_at, created_at) desc limit 200) l
    cross join lateral (
      select count(i.worker_id)::int n,
             count(*) filter (where r.demand_status = 'done')::int d_ok,
             count(*) filter (where r.demand_status in ('error', 'skipped'))::int d_err,
             count(*) filter (where r.alloc_status = 'done')::int a_ok,
             count(*) filter (where r.alloc_status in ('error', 'skipped'))::int a_err,
             greatest(max(r.demand_at), max(r.alloc_at)) r_at
        from public.demand_list_items i
        left join public.list_item_results r on r.list_id = i.list_id and r.worker_id = i.worker_id
       where i.list_id = l.id and coalesce(i.active, true)) s;

  -- PBA / IAY works (IAY Tracker): MR fill due, filled waiting for a wage list
  select jsonb_build_object(
      'fill_due', count(*) filter (where m.end_date <= v_t and coalesce(m.status, '') not in ('Filled', 'WL Generated', 'Zero')),
      'fill_today', count(*) filter (where m.end_date = v_t and coalesce(m.status, '') not in ('Filled', 'WL Generated', 'Zero')),
      'running', count(*) filter (where m.end_date > v_t and coalesce(m.status, '') not in ('Filled', 'WL Generated', 'Zero')),
      'wl_wait', count(*) filter (where m.status = 'Filled'),
      'wl_done', count(*) filter (where m.status = 'WL Generated'),
      'report_at', (select max(w2.report_at) from public.iay_works w2 where w2.jc_prefix = v_pre))
    into v_iay
    from public.iay_mrs m join public.iay_works w on w.work_code = m.work_code
   where w.jc_prefix = v_pre and coalesce(w.work_status, '') <> 'Completed';

  select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'scope', s.scope, 'items', s.items, 'n', s.n,
                                               'amount', s.amount, 'at', s.seen_at) order by s.kind, s.scope), '[]'::jsonb)
    into v_snaps from public.pipeline_snaps s where s.gp_id = p_gp_id;

  -- wage lists of the lists' works + the last 60 days
  select coalesce(jsonb_agg(jsonb_build_object('wl', w.wl_no, 'fy', w.fy, 'date', w.wl_date, 'code', w.work_code, 'n', w.workers,
                                               'amt', w.amount, 'stage', w.stage, 'gen_at', w.generated_at, 'sent_at', w.sent_at)
                            order by w.updated_at desc), '[]'::jsonb)
    into v_wls
    from (select * from public.pipeline_wls w
           where w.gp_id = p_gp_id and (w.updated_at > now() - interval '60 days' or upper(w.work_code) = any (v_codes))
           order by w.updated_at desc limit 1500) w;

  -- which of these wage lists are PBA / IAY: the Send for payment page shows no work code, so look the
  -- WL number up in the IAY Tracker (iay_works.wl_no), in ⚖ WL Caste reports taken with "শুধু IAY",
  -- and through the MR numbers of ⚖ WL Caste reports (iay_mrs.mr_no)
  with c as (
    select distinct upper(x->>'wl') wl from public.pipeline_snaps s, jsonb_array_elements(s.items) x
     where s.gp_id = p_gp_id and s.kind = 'send_pay'
    union
    select upper(w.wl_no) from public.pipeline_wls w where w.gp_id = p_gp_id and w.updated_at > now() - interval '60 days')
  select coalesce(jsonb_agg(c.wl order by c.wl), '[]'::jsonb) into v_pba
    from c
   where exists (select 1 from public.iay_works iw where iw.jc_prefix = v_pre and upper(iw.wl_no) = c.wl)
      or exists (select 1 from public.wl_caste_reports r join public.wl_caste_batches b on b.id = r.batch_id
                  where r.gp_id = p_gp_id and upper(r.wl_no) = c.wl and b.iay_only)
      or exists (select 1 from public.wl_caste_reports r, jsonb_array_elements(r.mrs) m, public.iay_mrs im, public.iay_works iw
                  where r.gp_id = p_gp_id and upper(r.wl_no) = c.wl and (m->>'mr') ~ '^[0-9]{1,15}$'
                    and im.mr_no = (m->>'mr')::bigint and iw.work_code = im.work_code and iw.jc_prefix = v_pre);

  return jsonb_build_object('today', v_t, 'lists', v_lists, 'iay', v_iay, 'snaps', v_snaps, 'wls', v_wls, 'pba_wls', v_pba);
end $$;

revoke all on function public.admin_pipeline(smallint) from public, anon;
grant execute on function public.admin_pipeline(smallint) to authenticated;

select 'OK: Payment pipeline PBA wage lists (v218) installed' as result;
