-- =====================================================================
-- G RAM-G 4A List Builder — Account copy requests (2026-10-31)
-- Needs 2026-10-31_account_copy.sql (v180) first.
--
-- The Admin pastes / uploads the workers whose account is not frozen
-- (job card + name). They go to the supervisors of that GP (all of them,
-- or one chosen supervisor) as "📷 Account copy চাই". When a supervisor
-- sends the Account No, IFSC and photo the request shows "photo received".
-- The Admin checks the photo: ✔ Verify (the account is written into the
-- worker data, request closed) or ✕ Return with a reason (the request goes
-- back to the supervisor with that reason).
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create table if not exists public.account_requests (
  id           bigint generated always as identity primary key,
  gp_id        smallint not null references public.gram_panchayats(id),
  worker_id    bigint not null references public.workers(id) on delete cascade,
  assigned_to  uuid,                       -- null = every supervisor of the GP
  note         text,
  status       text not null default 'open' check (status in ('open', 'photo', 'closed')),
  photo_id     uuid,
  return_reason text,
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);
create unique index if not exists account_requests_one_open on public.account_requests (worker_id) where status <> 'closed';
create index if not exists account_requests_gp_idx on public.account_requests (gp_id, status);
alter table public.account_requests enable row level security;
revoke all on public.account_requests from anon, authenticated;

-- Admin: add requests. p_rows = [{"jc": "...", "name": "..."}, ...]
-- A row matches a worker of this GP by job card; when the job card has more
-- than one applicant, the name decides (closest name, must be similar).
create or replace function public.admin_add_account_requests(p_gp_id smallint, p_rows jsonb, p_assign uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
        r jsonb; v_jc text; v_name text; v_w bigint; v_n int; v_cnt int;
        v_added int := 0; v_already int := 0; v_missing jsonb := '[]'; v_unclear jsonb := '[]';
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if p_assign is not null and not exists (select 1 from public.profiles p where p.user_id = p_assign and p.role = 'gp_user' and p.gp_id = p_gp_id) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_jc := private.norm_card(r->>'jc'); v_name := lower(regexp_replace(coalesce(r->>'name', ''), '[^A-Za-z]+', '', 'g'));
    if v_jc = '' then continue; end if;
    select count(*) into v_cnt from public.workers w where w.gp_id = p_gp_id and private.norm_card(w.job_card_no) = v_jc;
    if v_cnt = 0 then v_missing := v_missing || jsonb_build_object('jc', r->>'jc', 'name', r->>'name'); continue; end if;
    v_w := null;
    if v_name <> '' then
      select w.id into v_w from public.workers w
       where w.gp_id = p_gp_id and private.norm_card(w.job_card_no) = v_jc
         and extensions.similarity(lower(regexp_replace(w.applicant_name, '[^A-Za-z]+', '', 'g')), v_name) >= 0.35
       order by extensions.similarity(lower(regexp_replace(w.applicant_name, '[^A-Za-z]+', '', 'g')), v_name) desc, w.applicant_no
       limit 1;
    elsif v_cnt = 1 then
      select w.id into v_w from public.workers w where w.gp_id = p_gp_id and private.norm_card(w.job_card_no) = v_jc;
    end if;
    if v_w is null then v_unclear := v_unclear || jsonb_build_object('jc', r->>'jc', 'name', r->>'name'); continue; end if;
    insert into public.account_requests (gp_id, worker_id, assigned_to, note, created_by)
    values (p_gp_id, v_w, p_assign, nullif(left(trim(coalesce(p_note, '')), 200), ''), v_uid)
    on conflict (worker_id) where status <> 'closed' do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then v_added := v_added + 1; else v_already := v_already + 1; end if;
  end loop;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'account_request_add', 'account_requests', null, jsonb_build_object('added', v_added, 'already', v_already));
  return jsonb_build_object('added', v_added, 'already', v_already, 'not_found', v_missing, 'unclear', v_unclear);
end $$;

-- Admin: open requests of a GP (and closed ones of the last 30 days with p_all)
create or replace function public.admin_account_requests(p_gp_id smallint, p_all boolean default false)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', q.id, 'status', q.status, 'created_at', q.created_at, 'note', q.note,
      'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name, 'village_no', w.village_no,
      'account_no', wa.account_no, 'assigned', coalesce(nullif(p.full_name, ''), p.username))
      order by q.status, w.village_no, w.household_no, w.applicant_no)
    from public.account_requests q
    join public.workers w on w.id = q.worker_id
    left join public.worker_accounts wa on wa.worker_id = q.worker_id
    left join public.profiles p on p.user_id = q.assigned_to
    where q.gp_id = p_gp_id and (q.status <> 'closed' or (p_all and q.closed_at > now() - interval '30 days'))), '[]'::jsonb);
end $$;

create or replace function public.admin_close_account_requests(p_ids bigint[])
returns integer language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_n int;
begin
  select case when count(distinct q.gp_id) = 1 then min(q.gp_id) else -1 end into v_gp
    from public.account_requests q where q.id = any (coalesce(p_ids, '{}'));
  perform private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  update public.account_requests set status = 'closed', closed_at = now() where id = any (p_ids) and status <> 'closed';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Supervisor: requests for me (or for every supervisor of my GP)
create or replace function public.get_account_requests()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', q.id, 'status', q.status, 'note', q.note, 'worker_id', w.id,
      'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
      'village_no', w.village_no, 'household_no', w.household_no)
      order by w.village_no, w.household_no, w.job_card_no, w.applicant_no)
    from public.account_requests q join public.workers w on w.id = q.worker_id
    where q.gp_id = v_gp and q.status in ('open', 'photo')
      and (q.assigned_to is null or q.assigned_to = auth.uid())), '[]'::jsonb);
end $$;

-- A photo sent for a requested worker marks the request "photo received".
create or replace function private.trg_account_photo_request()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'INSERT' then
    update public.account_requests set status = 'photo', photo_id = new.id
     where worker_id = new.worker_id and status in ('open', 'photo');
  elsif new.status = 'done' and old.status is distinct from 'done' then
    update public.account_requests set status = 'closed', closed_at = now()
     where worker_id = new.worker_id and status <> 'closed';
  end if;
  return null;
end $$;
drop trigger if exists account_photo_request on public.account_photos;
create trigger account_photo_request after insert or update of status on public.account_photos
  for each row execute function private.trg_account_photo_request();

revoke all on function private.trg_account_photo_request() from public, anon, authenticated;
revoke all on function public.admin_add_account_requests(smallint, jsonb, uuid, text), public.admin_account_requests(smallint, boolean),
  public.admin_close_account_requests(bigint[]), public.get_account_requests() from public, anon;
grant execute on function public.admin_add_account_requests(smallint, jsonb, uuid, text), public.admin_account_requests(smallint, boolean),
  public.admin_close_account_requests(bigint[]), public.get_account_requests() to authenticated;

-- =====================================================================
-- Part 2: Account No + IFSC with the photo, Admin Verify / Return
-- =====================================================================
alter table public.account_requests add column if not exists return_reason text;
alter table public.account_photos add column if not exists account_no text;
alter table public.account_photos add column if not exists ifsc text;
alter table public.account_photos add column if not exists return_reason text;
alter table public.account_photos drop constraint if exists account_photos_status_check;
alter table public.account_photos add constraint account_photos_status_check
  check (status in ('new', 'done', 'replaced', 'returned'));

-- Supervisor: register the uploaded photo, with the Account No and IFSC.
drop function if exists public.add_account_photo(bigint, uuid, text, integer);
create or replace function public.add_account_photo(p_worker_id bigint, p_list_id uuid, p_path text, p_size integer,
                                                    p_account_no text default null, p_ifsc text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_old text[]; v_id uuid;
        v_acc text := nullif(regexp_replace(coalesce(p_account_no, ''), '\s+', '', 'g'), '');
        v_ifsc text := nullif(upper(regexp_replace(coalesce(p_ifsc, ''), '\s+', '', 'g')), '');
begin
  if not exists (select 1 from public.workers w where w.id = p_worker_id and w.gp_id = v_gp) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if v_acc is not null and v_acc !~ '^[0-9]{6,20}$' then raise exception 'BAD_ACCOUNT_NO' using errcode = '22023'; end if;
  if v_ifsc is not null and v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then raise exception 'BAD_IFSC' using errcode = '22023'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> v_gp::text or split_part(p_path, '/', 2) <> auth.uid()::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'account-copies' and o.name = p_path) then
    raise exception 'PHOTO_NOT_FOUND' using errcode = '22023';
  end if;
  if p_list_id is not null and not exists (select 1 from public.demand_lists l where l.id = p_list_id and l.gp_id = v_gp) then
    p_list_id := null;
  end if;
  with r as (
    update public.account_photos set status = 'replaced'
     where worker_id = p_worker_id and gp_id = v_gp and status = 'new' and purged_at is null
    returning path)
  select coalesce(array_agg(path), '{}') into v_old from r;
  insert into public.account_photos (gp_id, worker_id, list_id, path, size_bytes, uploaded_by, account_no, ifsc)
  values (v_gp, p_worker_id, p_list_id, p_path, p_size, auth.uid(), v_acc, v_ifsc)
  on conflict (path) do nothing
  returning id into v_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_gp, 'account_photo_add', 'workers', p_worker_id::text,
          jsonb_build_object('path', p_path, 'size', p_size, 'account_no', v_acc, 'ifsc', v_ifsc));
  return jsonb_build_object('id', v_id, 'old_paths', to_jsonb(v_old));
end $$;
revoke all on function public.add_account_photo(bigint, uuid, text, integer, text, text) from public, anon;
grant execute on function public.add_account_photo(bigint, uuid, text, integer, text, text) to authenticated;

-- Supervisor: requests now also say why the Admin returned one.
create or replace function public.get_account_requests()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', q.id, 'status', q.status, 'note', q.note, 'return_reason', q.return_reason, 'worker_id', w.id,
      'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
      'village_no', w.village_no, 'household_no', w.household_no)
      order by w.village_no, w.household_no, w.job_card_no, w.applicant_no)
    from public.account_requests q join public.workers w on w.id = q.worker_id
    where q.gp_id = v_gp and q.status in ('open', 'photo')
      and (q.assigned_to is null or q.assigned_to = auth.uid())), '[]'::jsonb);
end $$;

-- Admin list: what the supervisor wrote next to what the data has.
create or replace function public.admin_account_photos(p_gp_id smallint, p_status text default 'new')
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_scope smallint := private.admin_scope();
begin
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'path', a.path, 'status', a.status, 'size', a.size_bytes,
        'uploaded_at', a.uploaded_at, 'done_at', a.done_at, 'return_reason', a.return_reason,
        'sent_account_no', a.account_no, 'sent_ifsc', a.ifsc,
        'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
        'village_no', w.village_no, 'account_no', wa.account_no, 'ifsc', wa.ifsc,
        'requested', exists (select 1 from public.account_requests q where q.worker_id = a.worker_id and q.status <> 'closed'),
        'work_name', l.work_name, 'uploaded_by', coalesce(nullif(p.full_name, ''), p.username))
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

-- Admin ✔ Verify: the photo is marked done (the panel deletes the file);
-- with p_update the Account No / IFSC go into the worker data.
create or replace function public.admin_account_photo_verify(p_id uuid, p_update boolean default true)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_a public.account_photos%rowtype; v_upd boolean := false;
begin
  select * into v_a from public.account_photos where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  perform private.require_admin_gp(v_a.gp_id);
  if v_a.status <> 'new' then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
  if p_update and v_a.account_no ~ '^[0-9]{6,20}$' and v_a.ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$' then
    insert into public.worker_accounts (worker_id, account_no, ifsc, updated_at)
    values (v_a.worker_id, v_a.account_no, v_a.ifsc, now())
    on conflict (worker_id) do update set account_no = excluded.account_no, ifsc = excluded.ifsc, updated_at = now();
    v_upd := true;
  end if;
  update public.account_photos set status = 'done', done_at = now(), done_by = auth.uid() where id = p_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_a.gp_id, 'account_verify', 'workers', v_a.worker_id::text,
          jsonb_build_object('account_no', v_a.account_no, 'ifsc', v_a.ifsc, 'data_updated', v_upd));
  return jsonb_build_object('paths', jsonb_build_array(v_a.path), 'data_updated', v_upd);
end $$;

-- Admin ✕ Return: the request goes back to the supervisor with the reason.
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
  -- request (made now if the photo came without one) goes back to the uploader's GP supervisors
  update public.account_requests set status = 'open', return_reason = v_reason, photo_id = null
   where worker_id = v_a.worker_id and status <> 'closed';
  if not found then
    insert into public.account_requests (gp_id, worker_id, assigned_to, status, return_reason, created_by)
    values (v_a.gp_id, v_a.worker_id, v_a.uploaded_by, 'open', v_reason, auth.uid());
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_a.gp_id, 'account_return', 'workers', v_a.worker_id::text, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('paths', jsonb_build_array(v_a.path));
end $$;

-- Trigger: a new photo clears an old return reason.
create or replace function private.trg_account_photo_request()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'INSERT' then
    update public.account_requests set status = 'photo', photo_id = new.id, return_reason = null
     where worker_id = new.worker_id and status in ('open', 'photo');
  elsif new.status = 'done' and old.status is distinct from 'done' then
    update public.account_requests set status = 'closed', closed_at = now()
     where worker_id = new.worker_id and status <> 'closed';
  end if;
  return null;
end $$;
revoke all on function private.trg_account_photo_request() from public, anon, authenticated;

revoke all on function public.admin_account_photo_verify(uuid, boolean), public.admin_account_photo_return(uuid, text) from public, anon;
grant execute on function public.admin_account_photo_verify(uuid, boolean), public.admin_account_photo_return(uuid, text) to authenticated;

select 'OK: Account copy requests + Account No/IFSC + Verify/Return installed' as result;
