-- =====================================================================
-- Gram Setu — Account check page: Admin edit + ↩ bring back (v239, 2026-11-27)
-- Needs v181 (account requests), v183 (R2), v184/v235 (K-Desk bank queue) first.
--
--  * Admin can correct Account No / IFSC / passbook name before ✔ Verify.
--    The supervisor's original values are kept in sup_account_no / sup_ifsc /
--    sup_holder_name; account_no / ifsc / holder_name hold the final values, so
--    the K-Desk Bank queue (kdesk_bank_pending) needs no change.
--  * Verify keeps the worker's old account (prev_account) so ↩ can put it back.
--  * ↩ Bring back (admin_account_photo_reopen): a Verified or Returned copy
--    goes back to "new" (check again) for 7 days after it was done.
--  * Photos are no longer deleted at Verify / Return: kept 7 days, then the
--    usual cleanup deletes them. New (unchecked) photos: 30 days as before.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================
begin;

alter table public.account_photos add column if not exists sup_account_no text;
alter table public.account_photos add column if not exists sup_ifsc text;
alter table public.account_photos add column if not exists sup_holder_name text;
alter table public.account_photos add column if not exists prev_account jsonb;      -- worker_accounts row before Verify (null = had none)
alter table public.account_photos add column if not exists acc_written boolean not null default false;
alter table public.account_photos add column if not exists reopened_at timestamptz;

-- ✔ Verify, now with the Admin's corrected values (all optional: null = keep).
drop function if exists public.admin_account_photo_verify(uuid, boolean);
create or replace function public.admin_account_photo_verify(p_id uuid, p_update boolean default true,
                                                             p_account_no text default null, p_ifsc text default null,
                                                             p_holder_name text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_a public.account_photos%rowtype; v_upd boolean := false; v_prev jsonb; v_edit boolean := false;
        v_acc text := nullif(regexp_replace(coalesce(p_account_no, ''), '\s+', '', 'g'), '');
        v_ifsc text := nullif(upper(regexp_replace(coalesce(p_ifsc, ''), '\s+', '', 'g')), '');
        v_holder text := nullif(left(upper(regexp_replace(trim(coalesce(p_holder_name, '')), '\s+', ' ', 'g')), 100), '');
begin
  select * into v_a from public.account_photos where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  perform private.require_admin_gp(v_a.gp_id);
  if v_a.status <> 'new' then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
  if v_acc is not null and v_acc !~ '^[0-9]{6,20}$' then raise exception 'BAD_ACCOUNT_NO' using errcode = '22023'; end if;
  if v_ifsc is not null and v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then raise exception 'BAD_IFSC' using errcode = '22023'; end if;

  -- Admin corrections: keep the supervisor's first values once, then overwrite.
  if (v_acc is not null and v_acc is distinct from v_a.account_no)
     or (v_ifsc is not null and v_ifsc is distinct from v_a.ifsc)
     or (v_holder is not null and v_holder is distinct from v_a.holder_name) then
    v_edit := true;
    update public.account_photos set
      sup_account_no = case when sup_account_no is null and sup_ifsc is null and sup_holder_name is null then account_no else sup_account_no end,
      sup_ifsc = case when sup_account_no is null and sup_ifsc is null and sup_holder_name is null then ifsc else sup_ifsc end,
      sup_holder_name = case when sup_account_no is null and sup_ifsc is null and sup_holder_name is null then holder_name else sup_holder_name end
     where id = p_id;
    update public.account_photos set account_no = coalesce(v_acc, account_no), ifsc = coalesce(v_ifsc, ifsc),
                                     holder_name = coalesce(v_holder, holder_name)
     where id = p_id
     returning * into v_a;
  end if;

  if p_update and v_a.account_no ~ '^[0-9]{6,20}$' and v_a.ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    select to_jsonb(wa) into v_prev from public.worker_accounts wa where wa.worker_id = v_a.worker_id;
    insert into public.worker_accounts (worker_id, account_no, ifsc, updated_at)
    values (v_a.worker_id, v_a.account_no, v_a.ifsc, now())
    on conflict (worker_id) do update set account_no = excluded.account_no, ifsc = excluded.ifsc, updated_at = now();
    v_upd := true;
  end if;
  update public.account_photos set status = 'done', done_at = now(), done_by = auth.uid(),
         prev_account = v_prev, acc_written = v_upd, portal_status = null, portal_note = null, portal_at = null
   where id = p_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_a.gp_id, 'account_verify', 'workers', v_a.worker_id::text,
          jsonb_build_object('account_no', v_a.account_no, 'ifsc', v_a.ifsc, 'data_updated', v_upd,
                             'edited', v_edit, 'sup_account_no', v_a.sup_account_no, 'sup_ifsc', v_a.sup_ifsc,
                             'old_account_no', v_prev->>'account_no', 'old_ifsc', v_prev->>'ifsc'));
  -- the photo stays 7 days (↩ bring back); the cleanup deletes it later
  return jsonb_build_object('paths', '[]'::jsonb, 'data_updated', v_upd, 'edited', v_edit);
end $$;

-- ✕ Return: same as v181, but the photo stays 7 days (↩ bring back).
create or replace function public.admin_account_photo_return(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_a public.account_photos%rowtype; v_reason text := nullif(left(trim(coalesce(p_reason, '')), 200), '');
begin
  select * into v_a from public.account_photos where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  perform private.require_admin_gp(v_a.gp_id);
  if v_a.status <> 'new' then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
  if v_reason is null then raise exception 'NEED_REASON' using errcode = '22023'; end if;
  update public.account_photos set status = 'returned', return_reason = v_reason, done_at = now(), done_by = auth.uid() where id = p_id;
  update public.account_requests set status = 'open', return_reason = v_reason, photo_id = null
   where worker_id = v_a.worker_id and status <> 'closed';
  if not found then
    insert into public.account_requests (gp_id, worker_id, assigned_to, status, return_reason, created_by)
    values (v_a.gp_id, v_a.worker_id, v_a.uploaded_by, 'open', v_reason, auth.uid());
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_a.gp_id, 'account_return', 'workers', v_a.worker_id::text, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('paths', '[]'::jsonb);
end $$;

-- ↩ Bring back a Verified / Returned copy (≤ 7 days) so the Admin can edit and check it again.
create or replace function public.admin_account_photo_reopen(p_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_a public.account_photos%rowtype; v_cur public.worker_accounts%rowtype; v_restored text := 'none';
begin
  select * into v_a from public.account_photos where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  perform private.require_admin_gp(v_a.gp_id);
  if v_a.status not in ('done', 'returned') then raise exception 'NOT_DONE' using errcode = '22023'; end if;
  if v_a.purged_at is not null or v_a.done_at < now() - interval '7 days' then raise exception 'TOO_OLD' using errcode = '22023'; end if;
  if exists (select 1 from public.account_photos x where x.worker_id = v_a.worker_id and x.id <> v_a.id
               and (x.status = 'new' or (x.status = 'done' and x.done_at > v_a.done_at))) then
    raise exception 'NEWER_COPY' using errcode = '22023';
  end if;

  if v_a.status = 'done' and v_a.acc_written then
    select * into v_cur from public.worker_accounts where worker_id = v_a.worker_id;
    -- put the old account back only if nobody changed it since this Verify
    if found and v_cur.account_no is not distinct from v_a.account_no and v_cur.ifsc is not distinct from v_a.ifsc then
      if v_a.prev_account is null then
        delete from public.worker_accounts where worker_id = v_a.worker_id;
        v_restored := 'removed';
      else
        update public.worker_accounts set account_no = v_a.prev_account->>'account_no', ifsc = v_a.prev_account->>'ifsc',
               updated_at = now() where worker_id = v_a.worker_id;
        v_restored := 'old';
      end if;
    else
      v_restored := 'changed_since';
    end if;
  end if;

  update public.account_photos set status = 'new', done_at = null, done_by = null, return_reason = null,
         acc_written = false, prev_account = null, reopened_at = now(),
         portal_status = null, portal_note = null, portal_at = null
   where id = p_id;
  -- the supervisor's request is "photo received" again
  update public.account_requests set status = 'photo', photo_id = v_a.id, return_reason = null, closed_at = null
   where id = (select q.id from public.account_requests q where q.worker_id = v_a.worker_id
                order by (q.status <> 'closed') desc, q.created_at desc limit 1);
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_a.gp_id, 'account_reopen', 'workers', v_a.worker_id::text,
          jsonb_build_object('was', v_a.status, 'account_no', v_a.account_no, 'ifsc', v_a.ifsc,
                             'portal_status', v_a.portal_status, 'restored', v_restored));
  return jsonb_build_object('was', v_a.status, 'portal_status', v_a.portal_status, 'restored', v_restored);
end $$;

-- Cleanup list: new photos after 30 days; Verified / Returned 7 days after done; replaced at once.
create or replace function public.admin_account_photo_cleanup(p_gp_id smallint)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'path', a.path))
    from public.account_photos a
   where a.gp_id = p_gp_id and a.purged_at is null
     and ((a.status = 'new' and a.uploaded_at < now() - interval '30 days')
       or (a.status in ('done', 'returned') and coalesce(a.done_at, a.uploaded_at) < now() - interval '7 days')
       or a.status not in ('new', 'done', 'returned'))), '[]'::jsonb);
end $$;

-- Admin list: + supervisor originals, eKYC/ABPS, sansad, whether ↩ is possible.
create or replace function public.admin_account_photos(p_gp_id smallint, p_status text default 'new')
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_scope smallint := private.admin_scope();
begin
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'path', a.path, 'status', a.status, 'size', a.size_bytes,
        'uploaded_at', a.uploaded_at, 'done_at', a.done_at, 'return_reason', a.return_reason,
        'sent_account_no', a.account_no, 'sent_ifsc', a.ifsc, 'holder_name', a.holder_name,
        'sup_account_no', a.sup_account_no, 'sup_ifsc', a.sup_ifsc, 'sup_holder_name', a.sup_holder_name,
        'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
        'village_no', w.village_no, 'ekyc', w.ekyc, 'abps', w.abps,
        'account_no', wa.account_no, 'ifsc', wa.ifsc,
        'requested', exists (select 1 from public.account_requests q where q.worker_id = a.worker_id and q.status <> 'closed'),
        'work_name', l.work_name, 'uploaded_by', coalesce(nullif(p.full_name, ''), p.username),
        'portal_status', a.portal_status, 'portal_note', a.portal_note, 'portal_at', a.portal_at,
        'reopened_at', a.reopened_at,
        'can_reopen', a.status in ('done', 'returned') and a.purged_at is null and a.done_at > now() - interval '7 days')
        order by case when a.status = 'new' then a.uploaded_at else a.done_at end desc)
      from public.account_photos a
      join public.workers w on w.id = a.worker_id
      left join public.worker_accounts wa on wa.worker_id = a.worker_id
      left join public.demand_lists l on l.id = a.list_id
      left join public.profiles p on p.user_id = a.uploaded_by
      where a.gp_id = p_gp_id
        and ((a.status = 'new' and a.purged_at is null and coalesce(p_status, 'new') in ('new', 'all'))
          or (a.status in ('done', 'returned') and a.done_at > now() - interval '30 days' and p_status in ('done', 'all')))), '[]'::jsonb),
    'new_count', (select count(*) from public.account_photos a where a.gp_id = p_gp_id and a.status = 'new' and a.purged_at is null),
    'stored_bytes', (select coalesce(sum(a.size_bytes), 0) from public.account_photos a
                      where a.purged_at is null and (v_scope is null or a.gp_id = p_gp_id)),
    'all_gps', v_scope is null);
end $$;

revoke all on function public.admin_account_photo_verify(uuid, boolean, text, text, text),
  public.admin_account_photo_return(uuid, text), public.admin_account_photo_reopen(uuid),
  public.admin_account_photo_cleanup(smallint), public.admin_account_photos(smallint, text) from public, anon;
grant execute on function public.admin_account_photo_verify(uuid, boolean, text, text, text),
  public.admin_account_photo_return(uuid, text), public.admin_account_photo_reopen(uuid),
  public.admin_account_photo_cleanup(smallint), public.admin_account_photos(smallint, text) to authenticated;

select private.schema_mark(239, 'Account check: Admin edit A/c/IFSC/name + ↩ bring back, photos kept 7 days');

commit;

notify pgrst, 'reload schema';
