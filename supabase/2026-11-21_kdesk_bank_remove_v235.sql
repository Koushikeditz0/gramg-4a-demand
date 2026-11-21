-- =====================================================================
-- Gram Setu — remove verified accounts from the K-Desk "Bank A/c Update" queue (v235, 2026-11-21)
-- Needs 2026-11-07_kdesk_account_requests_v184.sql (v184) first.
--
-- A verified account copy (account_photos status 'done') goes to K-Desk until
-- the portal says "UPDATED". When the Admin already did it by hand, or it keeps
-- failing, the Admin can now take it off the queue (portal_status 'removed'),
-- so K-Desk does not load it again. ↩ Undo puts it back. The row stays as a record.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================
begin;

alter table public.account_photos drop constraint if exists account_photos_portal_status_chk;
alter table public.account_photos add constraint account_photos_portal_status_chk
  check (portal_status is null or portal_status in ('ok', 'fail', 'removed'));

-- same as v184, but 'removed' rows are no longer sent to K-Desk
create or replace function public.kdesk_bank_pending(p_all boolean default false)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'jc', w.job_card_no, 'ap', w.applicant_no, 'name', w.applicant_name, 'holder', a.holder_name,
      'acc', a.account_no, 'ifsc', a.ifsc, 'verified_at', a.done_at, 'portal_status', a.portal_status, 'portal_note', a.portal_note)
      order by w.village_no, w.household_no, w.job_card_no, w.applicant_no)
    from public.account_photos a join public.workers w on w.id = a.worker_id
    where a.gp_id = v_gp and a.status = 'done'
      and a.account_no ~ '^[0-9]{6,20}$' and a.ifsc ~ '^[A-Z]{4}[0O][A-Z0-9]{6}$'
      and a.done_at > now() - interval '90 days'
      and (a.portal_status is null or a.portal_status = 'fail'
           or (p_all and a.portal_status = 'ok' and a.portal_at > now() - interval '30 days'))), '[]'::jsonb);
end $$;

-- Admin: what K-Desk will load now (p_removed: also the ones taken off in the last 90 days)
create or replace function public.admin_kdesk_bank_queue(p_gp_id smallint, p_removed boolean default false)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
      'village_no', w.village_no, 'holder_name', a.holder_name, 'account_no', a.account_no, 'ifsc', a.ifsc,
      'verified_at', a.done_at, 'portal_status', a.portal_status, 'portal_note', a.portal_note, 'portal_at', a.portal_at)
      order by a.portal_status nulls first, w.village_no, w.household_no, w.applicant_no)
    from public.account_photos a join public.workers w on w.id = a.worker_id
    where a.gp_id = p_gp_id and a.status = 'done'
      and a.account_no ~ '^[0-9]{6,20}$' and a.ifsc ~ '^[A-Z]{4}[0O][A-Z0-9]{6}$'
      and a.done_at > now() - interval '90 days'
      and (a.portal_status is null or a.portal_status = 'fail' or (p_removed and a.portal_status = 'removed'))), '[]'::jsonb);
end $$;

-- p_remove true: take off the K-Desk queue; false: put back (undo)
create or replace function public.admin_kdesk_bank_remove(p_ids uuid[], p_remove boolean default true)
returns integer language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_uid uuid; v_n int;
begin
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 1000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select case when count(distinct a.gp_id) = 1 then min(a.gp_id) else -1 end into v_gp
    from public.account_photos a where a.id = any (p_ids);
  v_uid := private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  if p_remove then
    update public.account_photos set portal_status = 'removed', portal_note = 'Removed by Admin', portal_at = now()
     where id = any (p_ids) and status = 'done' and (portal_status is null or portal_status = 'fail');
  else
    update public.account_photos set portal_status = null, portal_note = null, portal_at = null
     where id = any (p_ids) and status = 'done' and portal_status = 'removed';
  end if;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
    values (v_uid, v_gp, case when p_remove then 'bank_queue_remove' else 'bank_queue_undo' end, 'account_photos', null, jsonb_build_object('rows', v_n));
  end if;
  return v_n;
end $$;

revoke all on function public.admin_kdesk_bank_queue(smallint, boolean), public.admin_kdesk_bank_remove(uuid[], boolean) from public, anon;
grant execute on function public.admin_kdesk_bank_queue(smallint, boolean), public.admin_kdesk_bank_remove(uuid[], boolean) to authenticated;

select private.schema_mark(235, 'K-Desk Bank A/c Update: Admin can remove done accounts from the queue');

commit;

notify pgrst, 'reload schema';
