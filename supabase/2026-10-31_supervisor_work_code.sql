-- =====================================================================
-- G RAM-G 4A List Builder — supervisor Work Code (2026-10-31)
--   The supervisor can give a Work Code to their own Draft list
--   (the New list dialog and the "③ Supervisor" dialog).
--   The supervisor app also sees the Work Code of its lists.
--   The admin panel can still set or change it, as before.
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

-- list_json: same as before, plus work_code
create or replace function private.list_json(p_list_id uuid, p_with_items boolean)
returns jsonb language sql stable security definer set search_path to '' as $function$
  select jsonb_build_object(
    'list_id', l.id, 'version', l.version, 'work_name', l.work_name, 'supervisors', to_jsonb(l.supervisors),
    'work_code', l.work_code,
    'submit_state', l.submit_state, 'submitted_at', l.submitted_at, 'locked_at', l.locked_at,
    'updated_at', l.updated_at, 'created_at', l.created_at,
    'workers', (select count(*) from public.demand_list_items i where i.list_id = l.id),
    'required_supervisors', private.required_supervisors((select count(*)::int from public.demand_list_items i where i.list_id = l.id)))
  || case when p_with_items then jsonb_build_object('items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no,
               'applicant_name', w.applicant_name, 'village_no', w.village_no,
               'household_no', w.household_no, 'ekyc', w.ekyc, 'abps', w.abps,
               'eligible', w.eligible, 'active', w.active)
             order by i.added_at, w.id)
      from public.demand_list_items i join public.workers w on w.id = i.worker_id
      where i.list_id = l.id), '[]'::jsonb)) else '{}'::jsonb end
  from public.demand_lists l where l.id = p_list_id
$function$;

-- supervisor: Work Code of own Draft list (empty = remove it)
create or replace function public.set_list_work_code(p_list_id uuid, p_work_code text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_gp smallint := private.require_gp_user(); v_list public.demand_lists%rowtype;
        v_code text := nullif(regexp_replace(coalesce(p_work_code, ''), '\s+', '', 'g'), '');
begin
  select * into v_list from public.demand_lists
   where id = p_list_id and owner_id = auth.uid() and gp_id = v_gp and status = 'active' for update;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = '42501'; end if;
  if v_list.submit_state <> 'draft' then raise exception 'LIST_LOCKED' using errcode = '42501'; end if;
  if v_code is not null and (char_length(v_code) > 100 or v_code !~ '^[^/]+/[A-Za-z]{2,3}/[^/]+') then
    raise exception 'BAD_WORK_CODE' using errcode = '22023';
  end if;
  update public.demand_lists set work_code = v_code, version = version + 1, updated_at = now()
   where id = p_list_id returning * into v_list;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_gp, 'list_work_code', 'demand_lists', p_list_id::text, jsonb_build_object('to', v_code));
  return jsonb_build_object('work_code', v_code, 'version', v_list.version);
end $function$;

revoke all on function public.set_list_work_code(uuid, text) from public, anon;
grant execute on function public.set_list_work_code(uuid, text) to authenticated;

select 'OK: Supervisor Work Code installed' as result;
