-- =====================================================================
-- G RAM-G 4A List Builder — work dates on a list (v189, 2026-11-07)
--
-- On the ③ Work/Supervisor page the supervisor gives:
--   From date + Working days (e.g. 14). The app shows the To date itself with
--   the portal rule "6 + 1": total days = N + floor(N/6)  (14 → 16 days),
--   To = From + total − 1. Only From and N are stored; To is worked out.
-- Preview and PDF show them; the Admin panel / K-Desk can read them from
-- list_json (from_date, work_days).
--
-- Needs v179 (list_json with work_code). Run once in Supabase → SQL Editor.
-- Safe to run again.
-- =====================================================================

alter table public.demand_lists add column if not exists from_date date;
alter table public.demand_lists add column if not exists work_days smallint;
do $$ begin
  alter table public.demand_lists add constraint demand_lists_work_days_chk check (work_days is null or work_days between 1 and 100);
exception when duplicate_object then null; end $$;

-- list_json: same as v179, plus from_date + work_days
create or replace function private.list_json(p_list_id uuid, p_with_items boolean)
returns jsonb language sql stable security definer set search_path to '' as $function$
  select jsonb_build_object(
    'list_id', l.id, 'version', l.version, 'work_name', l.work_name, 'supervisors', to_jsonb(l.supervisors),
    'work_code', l.work_code, 'from_date', l.from_date, 'work_days', l.work_days,
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

-- supervisor: From date + working days of own Draft list (null = remove)
create or replace function public.set_list_dates(p_list_id uuid, p_from date, p_days integer)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_gp smallint := private.require_gp_user(); v_list public.demand_lists%rowtype;
begin
  select * into v_list from public.demand_lists
   where id = p_list_id and owner_id = auth.uid() and gp_id = v_gp and status = 'active' for update;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = '42501'; end if;
  if v_list.submit_state <> 'draft' then raise exception 'LIST_LOCKED' using errcode = '42501'; end if;
  if p_days is not null and (p_days < 1 or p_days > 100) then raise exception 'BAD_DAYS' using errcode = '22023'; end if;
  if p_from is not null and (p_from < current_date - 365 or p_from > current_date + 365) then
    raise exception 'BAD_DATE' using errcode = '22023';
  end if;
  update public.demand_lists set from_date = p_from, work_days = p_days, version = version + 1, updated_at = now()
   where id = p_list_id returning * into v_list;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_gp, 'list_dates', 'demand_lists', p_list_id::text, jsonb_build_object('from', p_from, 'days', p_days));
  return jsonb_build_object('from_date', v_list.from_date, 'work_days', v_list.work_days, 'version', v_list.version);
end $function$;

revoke all on function public.set_list_dates(uuid, date, integer) from public, anon;
grant execute on function public.set_list_dates(uuid, date, integer) to authenticated;

select 'OK: list dates installed' as result;
