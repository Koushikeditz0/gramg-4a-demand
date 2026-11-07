-- =====================================================================
-- G RAM-G 4A List Builder — Account copy requests from K-Desk (v184, 2026-11-07)
-- Needs 2026-10-31_account_requests.sql (v181) first.
--
-- On the portal's Wage List page K-Desk reads the workers whose bank
-- account is not frozen and sends them here with the GP's "kdesk" login.
-- They become the same "📷 Account copy চাই" requests the Admin panel makes
-- (sent to every supervisor of that GP). Only the kdesk login's own GP.
--
-- Part 2: K-Desk "🏦 Bank A/c Update" on the portal page EditAppBank.aspx loads
-- the accounts the Admin ✔ Verified (account_photos status 'done' with a valid
-- Account No + IFSC) and, after the portal says "record(s) UPDATED", marks them
-- portal_status 'ok' (else 'fail' with the portal's message). The Admin panel
-- shows that on the verified card.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

-- p_rows = [{"jc": "...", "ap": 1, "name": "..."}, ...]
-- Matching: job card + Applicant No (the Wage List page shows it); without "ap",
-- or when that applicant is not in the app, the same name matching as admin_add_account_requests.
create or replace function public.kdesk_add_account_requests(p_rows jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_uid uuid := auth.uid();
        r jsonb; v_jc text; v_name text; v_w bigint; v_n int; v_cnt int;
        v_added int := 0; v_already int := 0; v_missing jsonb := '[]'; v_unclear jsonb := '[]';
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_jc := private.norm_card(r->>'jc'); v_name := lower(regexp_replace(coalesce(r->>'name', ''), '[^A-Za-z]+', '', 'g'));
    if v_jc = '' then continue; end if;
    select count(*) into v_cnt from public.workers w where w.gp_id = v_gp and private.norm_card(w.job_card_no) = v_jc;
    if v_cnt = 0 then v_missing := v_missing || jsonb_build_object('jc', r->>'jc', 'name', r->>'name'); continue; end if;
    v_w := null;
    if coalesce(r->>'ap', '') ~ '^[0-9]{1,4}$' then
      select w.id into v_w from public.workers w
       where w.gp_id = v_gp and private.norm_card(w.job_card_no) = v_jc and w.applicant_no = (r->>'ap')::int;
    end if;
    if v_w is not null then null;
    elsif v_name <> '' then
      select w.id into v_w from public.workers w
       where w.gp_id = v_gp and private.norm_card(w.job_card_no) = v_jc
         and extensions.similarity(lower(regexp_replace(w.applicant_name, '[^A-Za-z]+', '', 'g')), v_name) >= 0.35
       order by extensions.similarity(lower(regexp_replace(w.applicant_name, '[^A-Za-z]+', '', 'g')), v_name) desc, w.applicant_no
       limit 1;
    elsif v_cnt = 1 then
      select w.id into v_w from public.workers w where w.gp_id = v_gp and private.norm_card(w.job_card_no) = v_jc;
    end if;
    if v_w is null then v_unclear := v_unclear || jsonb_build_object('jc', r->>'jc', 'name', r->>'name'); continue; end if;
    insert into public.account_requests (gp_id, worker_id, assigned_to, note, created_by)
    values (v_gp, v_w, null, nullif(left(trim(coalesce(p_note, '')), 200), ''), v_uid)
    on conflict (worker_id) where status <> 'closed' do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then v_added := v_added + 1; else v_already := v_already + 1; end if;
  end loop;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'account_request_add_kdesk', 'account_requests', null, jsonb_build_object('added', v_added, 'already', v_already));
  return jsonb_build_object('added', v_added, 'already', v_already, 'not_found', v_missing, 'unclear', v_unclear);
end $$;

revoke all on function public.kdesk_add_account_requests(jsonb, text) from public, anon;
grant execute on function public.kdesk_add_account_requests(jsonb, text) to authenticated;


-- ---------------------------------------------------------------------
-- Part 2: verified accounts → portal (K-Desk Bank A/c Update)
-- ---------------------------------------------------------------------
alter table public.account_photos add column if not exists portal_status text;
alter table public.account_photos add column if not exists portal_note text;
alter table public.account_photos add column if not exists portal_at timestamptz;
do $$ begin
  alter table public.account_photos add constraint account_photos_portal_status_chk check (portal_status is null or portal_status in ('ok', 'fail'));
exception when duplicate_object then null; end $$;

-- Verified accounts of the kdesk login's GP that are not yet updated on the portal (p_all: also the 'ok' ones of 30 days)
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
      and (a.portal_status is distinct from 'ok' or (p_all and a.portal_at > now() - interval '30 days'))), '[]'::jsonb);
end $$;

-- p_rows = [{"id": "<account_photos id>", "s": "ok"|"fail", "m": "portal message"}, ...]
create or replace function public.kdesk_bank_report(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); r jsonb; v_n int; v_done int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'s', '') not in ('ok', 'fail') or coalesce(r->>'id', '') !~ '^[0-9a-f-]{36}$' then continue; end if;
    update public.account_photos set portal_status = r->>'s', portal_note = left(coalesce(r->>'m', ''), 300), portal_at = now()
     where id = (r->>'id')::uuid and gp_id = v_gp and status = 'done' and portal_status is distinct from 'ok';
    get diagnostics v_n = row_count; v_done := v_done + v_n;
  end loop;
  if v_done > 0 then
    insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
    values (auth.uid(), v_gp, 'bank_portal_report_kdesk', 'account_photos', null, jsonb_build_object('rows', v_done));
  end if;
  return jsonb_build_object('updated', v_done);
end $$;

revoke all on function public.kdesk_bank_pending(boolean), public.kdesk_bank_report(jsonb) from public, anon;
grant execute on function public.kdesk_bank_pending(boolean), public.kdesk_bank_report(jsonb) to authenticated;

-- Admin panel: same as v182 + portal_status / portal_note / portal_at
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
        'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
        'village_no', w.village_no, 'account_no', wa.account_no, 'ifsc', wa.ifsc,
        'requested', exists (select 1 from public.account_requests q where q.worker_id = a.worker_id and q.status <> 'closed'),
        'work_name', l.work_name, 'uploaded_by', coalesce(nullif(p.full_name, ''), p.username),
        'portal_status', a.portal_status, 'portal_note', a.portal_note, 'portal_at', a.portal_at)
        order by a.uploaded_at desc)
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
