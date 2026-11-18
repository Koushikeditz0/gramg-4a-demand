-- =====================================================================
-- v225 · Admin panel: 🔍 search (Ctrl+K) + worker drawer
--
-- admin_find(gp, text)        → workers (name / Job Card), works (name / code),
--                               lists (work name / supervisor), MR / WL numbers
-- admin_worker_card(gp, id)   → one worker: flags, account, marks, lists with
--                               K-Desk results, account-copy photos, PBA work
-- Read only. Super Admin or the GP's own GP Admin (private.require_admin_gp).
--
-- Supabase dashboard → project gramg-4a-demand → SQL Editor → paste all → Run.
-- =====================================================================
begin;

create or replace function public.admin_find(p_gp_id smallint, p_q text)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_uid uuid := private.require_admin_gp(p_gp_id);
  q text := btrim(coalesce(p_q, ''));
  lk text;
  v_vill integer; v_hh integer;
begin
  if length(q) < 2 then return jsonb_build_object('workers', '[]'::jsonb, 'works', '[]'::jsonb, 'lists', '[]'::jsonb, 'mrs', '[]'::jsonb); end if;
  lk := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- "002/118" or the full Job Card number → village / household
  if q ~ '(\d{1,3})/(\d{1,4})' then
    v_vill := (regexp_match(q, '(\d{1,3})/(\d{1,4})'))[1]::integer;
    v_hh   := (regexp_match(q, '(\d{1,3})/(\d{1,4})'))[2]::integer;
  end if;
  return jsonb_build_object(
    'workers', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no,
                 'name', w.applicant_name, 'village_no', w.village_no, 'village', vn.local_name, 'active', w.active) x
          from public.workers w
          left join public.village_names vn on vn.gp_id = w.gp_id and vn.village_no = w.village_no
         where w.gp_id = p_gp_id
           and (w.applicant_name ilike lk or w.job_card_no ilike lk
                or (v_vill is not null and w.village_no = v_vill and w.household_no = v_hh))
         order by w.active desc, w.village_no, w.household_no, w.applicant_no
         limit 12) s), '[]'::jsonb),
    'works', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('name', g.work_name, 'code', g.work_code, 'active', g.active) x
          from public.gp_works g
         where g.gp_id = p_gp_id and (g.work_name ilike lk or g.work_code ilike lk)
         order by g.active desc, g.work_name limit 6) s), '[]'::jsonb),
    'lists', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('id', l.id, 'work_name', l.work_name, 'work_code', l.work_code, 'state', l.submit_state,
                 'username', p.username, 'full_name', p.full_name, 'updated_at', l.updated_at) x
          from public.demand_lists l
          left join public.profiles p on p.user_id = l.owner_id
         where l.gp_id = p_gp_id and l.status = 'active'
           and (l.work_name ilike lk or l.work_code ilike lk or p.full_name ilike lk or p.username ilike lk)
         order by l.updated_at desc limit 6) s), '[]'::jsonb),
    'mrs', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('mr_no', m.mr_no, 'wl_no', m.wl_no, 'code', m.work_code, 'name', m.work_name,
                 'from', m.date_from, 'to', m.date_to, 'filled', m.filled) x
          from public.pipeline_mrs m
         where m.gp_id = p_gp_id and length(q) >= 3 and (m.mr_no ilike lk or m.wl_no ilike lk)
         order by m.date_from desc nulls last limit 6) s), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_find(smallint, text) from public, anon;
grant execute on function public.admin_find(smallint, text) to authenticated;

create or replace function public.admin_worker_card(p_gp_id smallint, p_worker_id bigint)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_uid uuid := private.require_admin_gp(p_gp_id);
  w public.workers;
begin
  select * into w from public.workers where id = p_worker_id and gp_id = p_gp_id;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  return jsonb_build_object(
    'worker', jsonb_build_object('id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'name', w.applicant_name,
       'village_no', w.village_no, 'village', (select local_name from public.village_names where gp_id = w.gp_id and village_no = w.village_no),
       'ekyc', w.ekyc, 'abps', w.abps, 'aadhaar_seeded', w.aadhaar_seeded, 'eligible', w.eligible,
       'active', w.active, 'inactive_reason', w.inactive_reason, 'inactive_at', w.inactive_at, 'keep_active', w.keep_active,
       'created_at', w.created_at, 'updated_at', w.updated_at),
    'account', (select jsonb_build_object('account_no', a.account_no, 'ifsc', a.ifsc, 'bank', a.bank_name, 'source', a.source, 'updated_at', a.updated_at)
                  from public.worker_accounts a where a.worker_id = w.id),
    'household', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'applicant_no', x.applicant_no, 'name', x.applicant_name, 'active', x.active) order by x.applicant_no)
                  from public.workers x where x.gp_id = w.gp_id and x.job_card_no = w.job_card_no and x.id <> w.id), '[]'::jsonb),
    'marks', coalesce((select jsonb_agg(jsonb_build_object('reason', m.reason, 'status', m.status, 'note', m.note, 'admin_note', m.admin_note, 'at', m.marked_at) order by m.marked_at desc)
                  from public.worker_marks m where m.worker_id = w.id), '[]'::jsonb),
    'photos', coalesce((select jsonb_agg(jsonb_build_object('status', ph.status, 'at', ph.uploaded_at, 'done_at', ph.done_at, 'reason', ph.return_reason) order by ph.uploaded_at desc)
                  from (select * from public.account_photos where worker_id = w.id order by uploaded_at desc limit 5) ph), '[]'::jsonb),
    'lists', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'work_name', l.work_name, 'work_code', coalesce(r.work_code, l.work_code),
                    'state', l.submit_state, 'list_status', l.status, 'from_date', l.from_date, 'work_days', l.work_days,
                    'username', p.username, 'in_list', i.active,
                    'demand', r.demand_status, 'demand_at', r.demand_at, 'alloc', r.alloc_status, 'alloc_at', r.alloc_at) order by l.updated_at desc)
                  from public.demand_list_items i
                  join public.demand_lists l on l.id = i.list_id
                  left join public.profiles p on p.user_id = l.owner_id
                  left join public.list_item_results r on r.list_id = i.list_id and r.worker_id = i.worker_id
                 where i.worker_id = w.id and l.deleted_at is null), '[]'::jsonb),
    'pba', coalesce((select jsonb_agg(jsonb_build_object('work_code', iw.work_code, 'ben', iw.ben_name, 'status', iw.work_status,
                    'wl_no', iw.wl_no, 'mrs', (select count(*) from public.iay_mrs m where m.work_code = iw.work_code)))
                  from public.iay_works iw where iw.jcn = w.job_card_no), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_worker_card(smallint, bigint) from public, anon;
grant execute on function public.admin_worker_card(smallint, bigint) to authenticated;

select private.schema_mark(225, 'Admin search (admin_find) + worker drawer (admin_worker_card)');

commit;
