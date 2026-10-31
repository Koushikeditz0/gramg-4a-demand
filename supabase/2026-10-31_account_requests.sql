-- =====================================================================
-- G RAM-G 4A List Builder — Account copy requests (2026-10-31)
-- Needs 2026-10-31_account_copy.sql (v180) first.
--
-- The Admin pastes / uploads the workers whose account is not frozen
-- (job card + name). They go to the supervisors of that GP (all of them,
-- or one chosen supervisor) as "📷 Account copy চাই". When a supervisor
-- sends the photo the request shows "photo received"; when the Admin
-- marks the photo Done, the request is closed.
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

select 'OK: Account copy requests installed' as result;
