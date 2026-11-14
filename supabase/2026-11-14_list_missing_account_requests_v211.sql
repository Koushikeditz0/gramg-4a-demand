-- =====================================================================
-- Gram Setu — missing accounts of a submitted list go to Bank Account (v211, 2026-11-14)
--
-- When a supervisor submits a list, workers of that list who have no
-- Account No / IFSC (and no passbook photo with an account already sent)
-- become account copy requests assigned to that supervisor, so they show
-- in the supervisor's 🏦 Bank Account section.
--
--   list_missing_account_requests(p_list_id) → {"added": n, "already": n}
--
-- Only the list's owner can call it. A worker who already has an open
-- request is skipped. New function only, nothing existing changes.
-- Needs v181 (account_requests). Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================
create or replace function public.list_missing_account_requests(p_list_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_added int := 0; v_missing int := 0;
begin
  if not exists (select 1 from public.demand_lists l
                 where l.id = p_list_id and l.owner_id = auth.uid() and l.gp_id = v_gp) then
    raise exception 'LIST_NOT_FOUND' using errcode = '42501';
  end if;
  with miss as (
    select i.worker_id
      from public.demand_list_items i
      join public.workers w on w.id = i.worker_id and w.gp_id = v_gp
      left join public.worker_accounts a on a.worker_id = i.worker_id
     where i.list_id = p_list_id
       and (nullif(btrim(a.account_no), '') is null or nullif(btrim(a.ifsc), '') is null)
       and not exists (select 1 from public.account_photos ph
                        where ph.worker_id = i.worker_id and ph.gp_id = v_gp
                          and ph.account_no is not null and ph.status in ('new', 'done'))),
  ins as (
    insert into public.account_requests (gp_id, worker_id, assigned_to, created_by)
    select v_gp, m.worker_id, auth.uid(), auth.uid() from miss m
    on conflict (worker_id) where status <> 'closed' do nothing
    returning 1)
  select (select count(*) from miss), (select count(*) from ins) into v_missing, v_added;
  if v_added > 0 then
    insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
    values (auth.uid(), v_gp, 'list_account_requests', 'demand_lists', p_list_id::text, jsonb_build_object('added', v_added));
  end if;
  return jsonb_build_object('added', v_added, 'already', v_missing - v_added);
end $$;
revoke all on function public.list_missing_account_requests(uuid) from public, anon;
grant execute on function public.list_missing_account_requests(uuid) to authenticated;
