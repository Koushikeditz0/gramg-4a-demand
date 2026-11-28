-- v240 (2026-11-28): Admin can set a list's From date + work days, so a draft that a
-- supervisor never submitted can be filled in and sent to K-Desk from the Admin panel.
-- Same checks as the supervisor's set_list_dates, but for admins (any state of an active list).
-- Safe to run again.
begin;

create or replace function public.admin_set_list_dates(p_list_id uuid, p_from date, p_days integer)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_list(p_list_id); v_list public.demand_lists%rowtype;
begin
  select * into v_list from public.demand_lists where id = p_list_id and status = 'active' for update;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = '42501'; end if;
  if p_days is not null and (p_days < 1 or p_days > 100) then raise exception 'BAD_DAYS' using errcode = '22023'; end if;
  if p_from is not null and (p_from < current_date - 365 or p_from > current_date + 365) then
    raise exception 'BAD_DATE' using errcode = '22023';
  end if;
  update public.demand_lists set from_date = p_from, work_days = p_days, version = version + 1, updated_at = now()
   where id = p_list_id returning * into v_list;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_list.gp_id, 'list_dates_by_admin', 'demand_lists', p_list_id::text, jsonb_build_object('from', p_from, 'days', p_days));
  return jsonb_build_object('from_date', v_list.from_date, 'work_days', v_list.work_days, 'version', v_list.version);
end $$;

revoke all on function public.admin_set_list_dates(uuid, date, integer) from public, anon;
grant execute on function public.admin_set_list_dates(uuid, date, integer) to authenticated;

select private.schema_mark(240, 'Admin can set list From date + days (send drafts to K-Desk)');

commit;

notify pgrst, 'reload schema';
