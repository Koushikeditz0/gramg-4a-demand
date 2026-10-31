-- =====================================================================
-- G RAM-G 4A List Builder — list delete (2026-10-31)
--   Supervisor: delete own Draft or Submitted list (workers inside are fine).
--               A Locked list cannot be deleted by the supervisor.
--   Admin / GP Admin: delete any list of their GP, in any state.
--   Soft delete: the list is hidden (status = 'archived', deleted_at set),
--   its workers can be picked for a new list again, and the list, its
--   submitted copies and K-Desk results stay in the database (Backup).
--   An empty list with no history is removed completely, as before.
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

alter table public.demand_lists add column if not exists deleted_at timestamptz;
alter table public.demand_lists add column if not exists deleted_by uuid;
do $$ begin
  alter table public.demand_lists add constraint demand_lists_deleted_by_fkey
    foreign key (deleted_by) references auth.users(id) on delete set null;
exception when duplicate_object then null; end $$;

-- shared by both delete functions; the caller has already checked who may delete
create or replace function private.soft_delete_list(p_list_id uuid, p_actor uuid, p_action text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_list public.demand_lists%rowtype; v_n integer; v_hard boolean;
begin
  select * into v_list from public.demand_lists where id = p_list_id and status = 'active' for update;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = '42501'; end if;
  select count(*) into v_n from public.demand_list_items where list_id = p_list_id;
  v_hard := v_n = 0
        and not exists (select 1 from public.list_submissions where list_id = p_list_id)
        and not exists (select 1 from public.list_item_results where list_id = p_list_id);
  if v_hard then
    delete from public.demand_lists where id = p_list_id;
  else
    update public.demand_list_items set active = false where list_id = p_list_id;   -- workers are free again
    update public.demand_lists
       set status = 'archived', deleted_at = now(), deleted_by = p_actor, version = version + 1, updated_at = now()
     where id = p_list_id;
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (p_actor, v_list.gp_id, p_action, 'demand_lists', p_list_id::text,
          jsonb_build_object('work_name', v_list.work_name, 'owner', v_list.owner_id,
                             'submit_state', v_list.submit_state, 'workers', v_n, 'hard', v_hard));
  return jsonb_build_object('work_name', v_list.work_name, 'workers', v_n, 'hard', v_hard);
end $function$;

-- supervisor app (was: only an empty Draft)
drop function if exists public.delete_list(uuid);
create or replace function public.delete_list(p_list_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_gp smallint := private.require_gp_user(); v_list public.demand_lists%rowtype;
begin
  select * into v_list from public.demand_lists
   where id = p_list_id and owner_id = auth.uid() and gp_id = v_gp and status = 'active' for update;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = '42501'; end if;
  if v_list.submit_state = 'locked' then raise exception 'LIST_LOCKED' using errcode = '42501'; end if;
  return private.soft_delete_list(p_list_id, auth.uid(), 'list_deleted');
end $function$;

-- admin panel (Super Admin: any GP, GP Admin: own GP)
create or replace function public.admin_delete_list(p_list_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_uid uuid := private.require_admin_list(p_list_id);
begin
  return private.soft_delete_list(p_list_id, v_uid, 'list_deleted_by_admin');
end $function$;

-- ---------- permissions ----------
revoke all on function private.soft_delete_list(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.delete_list(uuid) from public, anon;
revoke all on function public.admin_delete_list(uuid) from public, anon;
grant execute on function public.delete_list(uuid) to authenticated;
grant execute on function public.admin_delete_list(uuid) to authenticated;

select 'OK: List delete installed' as result;
