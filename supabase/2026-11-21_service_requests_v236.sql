-- =====================================================================
-- Gram Setu — সেবা অনুরোধ changes (v236, 2026-11-21). Needs v234 first.
--
-- Koushik 2026-11-21:
--  * Aadhaar Delink = this worker's Aadhaar is seeded in ANOTHER Job Card; delink it
--    there and seed it in this Job Card. New detail fields old_jc / old_name / old_gp / old_block.
--  * "New applicant in Job Card" is no longer offered (old rows stay as they are).
--  * New kind aadhaar_update (Aadhaar update / seed request). When Done the supervisor
--    is told to do eKYC again; the Super Admin can lock its Aadhaar No. like the others.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================
begin;

alter table public.service_requests drop constraint if exists service_requests_kind_check;
alter table public.service_requests add constraint service_requests_kind_check
  check (kind in ('aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh',
                  'applicant_add', 'aadhaar_update', 'payment', 'other', 'note'));

create or replace function private.sr_clean_details(p_kind text, p_details jsonb)
returns jsonb language plpgsql stable set search_path to '' as $$
declare v jsonb := '{}'::jsonb; k text; x jsonb; m jsonb; mem jsonb := '[]'::jsonb;
        keys text[] := array['reason', 'reason_text', 'shift_block', 'shift_gp', 'shift_jc', 'aadhaar_name', 'gender',
                             'right_worker_id', 'right_name', 'right_applicant_no', 'seeded', 'new_hoh', 'old_hoh', 'remarks',
                             'old_jc', 'old_name', 'old_gp', 'old_block'];
begin
  if p_details is null or jsonb_typeof(p_details) <> 'object' then return v; end if;
  foreach k in array keys loop
    x := p_details -> k;
    if x is null or jsonb_typeof(x) = 'null' then continue; end if;
    if jsonb_typeof(x) not in ('string', 'number') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    if length(btrim(x #>> '{}')) = 0 then continue; end if;
    v := v || jsonb_build_object(k, left(btrim(x #>> '{}'), 200));
  end loop;
  if p_kind = 'gender_hoh' and jsonb_typeof(p_details -> 'members') = 'array' then
    if jsonb_array_length(p_details -> 'members') > 30 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    for m in select * from jsonb_array_elements(p_details -> 'members') loop
      mem := mem || jsonb_build_array(jsonb_build_object(
        'name', left(btrim(coalesce(m ->> 'name', '')), 80), 'rel', left(btrim(coalesce(m ->> 'rel', '')), 40),
        'gender', left(btrim(coalesce(m ->> 'gender', '')), 12)));
    end loop;
    v := v || jsonb_build_object('members', mem);
  end if;
  perform private.sr_no_aadhaar(v::text);
  return v;
end $$;

create or replace function private.sr_insert(p_gp smallint, p_worker_id bigint, p_kind text, p_title text, p_note text,
                                             p_details jsonb, p_for uuid, p_by uuid, p_admin boolean)
returns bigint language plpgsql security definer set search_path to '' as $$
declare w public.workers%rowtype; v_id bigint; v_title text := nullif(left(btrim(coalesce(p_title, '')), 120), '');
        v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), ''); v_det jsonb;
begin
  -- (Applicant / Job Card delete = the Expired / Migrant mark, bank account = Account copy request: they stay there)
  if p_kind is null or p_kind not in ('aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh',
                                      'aadhaar_update', 'payment', 'other', 'note') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_kind = 'other' and v_title is null then raise exception 'NEED_TITLE' using errcode = '22023'; end if;
  if p_kind = 'note' and v_note is null then raise exception 'NEED_NOTE' using errcode = '22023'; end if;
  if p_worker_id is not null or p_kind <> 'note' then        -- a note may be about nobody in particular
    select * into w from public.workers x where x.id = p_worker_id and x.gp_id = p_gp;
    if not found then raise exception 'WORKER_NOT_FOUND' using errcode = '22023'; end if;
  end if;
  perform private.sr_no_aadhaar(v_title); perform private.sr_no_aadhaar(v_note);
  v_det := private.sr_clean_details(p_kind, p_details);
  if exists (select 1 from public.service_requests q where q.worker_id = p_worker_id and q.kind = p_kind and p_kind not in ('other', 'note')
               and q.status not in ('done', 'rejected', 'cancelled')) then
    raise exception 'ALREADY_OPEN' using errcode = '22023';
  end if;
  insert into public.service_requests (gp_id, worker_id, job_card_no, applicant_no, applicant_name, village_no, household_no,
                                       kind, title, note, details, for_user, created_by, by_admin, admin_at, history)
  values (p_gp, w.id, w.job_card_no, w.applicant_no, w.applicant_name, w.village_no, w.household_no,
          p_kind, v_title, v_note, v_det, p_for, p_by, p_admin, case when p_admin then now() end,
          jsonb_build_array(jsonb_build_object('at', now(), 'st', 'new', 'by', private.sr_name(p_by))))
  returning id into v_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (p_by, p_gp, 'service_request_add', 'service_requests', v_id::text, jsonb_build_object('kind', p_kind, 'by_admin', p_admin));
  return v_id;
end $$;

create or replace function public.admin_sr_set_status(p_ids bigint[], p_status text, p_remark text)
returns integer language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_uid uuid; v_n int; v_rm text := nullif(left(btrim(coalesce(p_remark, '')), 300), ''); v_by text;
begin
  if p_status is null or p_status not in ('new', 'working', 'block', 'district', 'done', 'rejected', 'cancelled') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_status = 'rejected' and v_rm is null then raise exception 'COMMENT_NEEDED' using errcode = '22023'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select case when count(distinct q.gp_id) = 1 and count(*) = cardinality(p_ids) then min(q.gp_id) else -1 end into v_gp
    from public.service_requests q where q.id = any (p_ids);
  v_uid := private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  perform private.sr_no_aadhaar(v_rm);
  v_by := private.sr_name(v_uid);
  update public.service_requests q
     set status = p_status, remark = v_rm, updated_at = now(), admin_at = now(),
         closed_at = case when p_status in ('done', 'rejected', 'cancelled') then coalesce(case when q.status = p_status then q.closed_at end, now()) end,
         ekyc_needed = case when p_status = 'done' and q.kind in ('aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh', 'aadhaar_update') then true
                            when p_status = 'done' then q.ekyc_needed else false end,
         ekyc_done_at = case when p_status = 'done' then q.ekyc_done_at end,
         history = q.history || jsonb_build_array(jsonb_build_object('at', now(), 'st', p_status, 'rm', v_rm, 'by', v_by))
   where q.id = any (p_ids);
  get diagnostics v_n = row_count;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'service_request_status', 'service_requests', null, jsonb_build_object('ids', to_jsonb(p_ids), 'status', p_status));
  return v_n;
end $$;

create or replace function public.admin_sr_aadhaar_set(p_id bigint, p_ct text, p_last4 text)
returns void language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.sr_require_super();
begin
  if not exists (select 1 from public.service_requests q where q.id = p_id
                  and q.kind in ('aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'aadhaar_update')) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_ct is null then delete from public.service_request_secrets where request_id = p_id; return; end if;
  if not exists (select 1 from public.service_request_lock) then raise exception 'NO_LOCK' using errcode = '22023'; end if;
  -- the locked text must not be a readable number
  if p_ct ~ '[0-9]{12}' and private.sr_has_aadhaar(p_ct) then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  insert into public.service_request_secrets (request_id, ct, last4, set_by) values (p_id, p_ct, nullif(p_last4, ''), v_uid)
  on conflict (request_id) do update set ct = excluded.ct, last4 = excluded.last4, set_at = now(), set_by = excluded.set_by;
end $$;

select private.schema_mark(236, 'সেবা অনুরোধ: Delink from another Job Card, Aadhaar update kind, no New applicant');

commit;

notify pgrst, 'reload schema';
