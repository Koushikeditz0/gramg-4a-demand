-- =====================================================================
-- v234 · সেবা অনুরোধ / Supervisor task requests (2026-11-21)
--
-- Also "note" (নোট / বার্তা): a free message Admin → one supervisor or
-- supervisor → Admin, with or without a worker.
--
-- Supervisors bring the Admin tasks such as Aadhaar Delink, name / gender
-- correction. (Applicant delete and bank account changes already have
-- their own places: Expired / Migrant mark and Account copy request.) Some go to the Block or District.
-- Now a supervisor (or the Admin on a supervisor's behalf) writes the
-- request in Gram Setu; the Admin sets its status (New → Working →
-- Sent to Block / District → Done / Rejected) with a remark, and the
-- supervisor sees every change with its date. When an Aadhaar related
-- task is Done the supervisor is told to do the worker's eKYC again.
--
-- Aadhaar numbers (Koushik's rule, 2026-11-21):
--   * Supervisors can NEVER send an Aadhaar number. Every text a supervisor
--     or Admin writes is checked: a valid 12-digit Aadhaar number is refused
--     (NO_AADHAAR).
--   * Only the Super Admin (Koushik) can store an Aadhaar number, and only
--     for the Block format Excel. The number is locked (AES-GCM) in his
--     browser with his own password BEFORE it is sent: the database and the
--     nightly backup hold only the locked text + the last 4 digits.
--     GP Admins, report viewers and supervisors never get it.
--   * The locked number is deleted 30 days after the request is closed.
--   * No Aadhaar card photo is stored anywhere.
--
-- Supabase dashboard → SQL Editor → paste all → Run. Safe to run twice.
-- =====================================================================
begin;

-- ---------------------------------------------------------------- tables
create table if not exists public.service_requests (
  id            bigint generated always as identity primary key,
  gp_id         smallint not null references public.gram_panchayats(id),
  worker_id     bigint references public.workers(id) on delete set null,
  job_card_no   text,                    -- copy, so the request stays readable if the worker row goes
  applicant_no  integer,
  applicant_name text,
  village_no    integer,
  household_no  integer,
  kind          text not null check (kind in ('aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh',
                                              'applicant_add', 'payment', 'other', 'note')),
  title         text,                    -- "other": what the task is
  note          text,                    -- supervisor's / Admin's note
  details       jsonb not null default '{}'::jsonb,   -- format fields (never an Aadhaar number)
  status        text not null default 'new' check (status in ('new', 'working', 'block', 'district', 'done', 'rejected', 'cancelled')),
  remark        text,                    -- Admin's latest remark (the supervisor sees it)
  history       jsonb not null default '[]'::jsonb,   -- [{at, st, rm, by}]
  for_user      uuid,                    -- the supervisor this request belongs to (null = Admin only)
  created_by    uuid not null,
  by_admin      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  admin_at      timestamptz,             -- last change made by the Admin (→ supervisor badge)
  seen_at       timestamptz,             -- supervisor last opened the requests page
  closed_at     timestamptz,
  ekyc_needed   boolean not null default false,
  ekyc_done_at  timestamptz
);
create index if not exists service_requests_gp_idx on public.service_requests (gp_id, status);
create index if not exists service_requests_for_idx on public.service_requests (for_user, status);
alter table public.service_requests enable row level security;
revoke all on public.service_requests from anon, authenticated;

-- Locked Aadhaar numbers (Super Admin only). ct = base64(iv + AES-GCM text) made in the browser.
create table if not exists public.service_request_secrets (
  request_id  bigint primary key references public.service_requests(id) on delete cascade,
  ct          text not null check (length(ct) between 20 and 2000),
  last4       text check (last4 ~ '^[0-9/ ]{0,20}$'),
  set_at      timestamptz not null default now(),
  set_by      uuid not null
);
alter table public.service_request_secrets enable row level security;
revoke all on public.service_request_secrets from anon, authenticated;

-- The password check of the lock: salt + a known text locked with the key. Never the password.
create table if not exists public.service_request_lock (
  id        integer primary key default 1 check (id = 1),
  salt      text not null,
  check_ct  text not null,
  set_at    timestamptz not null default now(),
  set_by    uuid not null
);
alter table public.service_request_lock enable row level security;
revoke all on public.service_request_lock from anon, authenticated;

-- Block name of each GP for the Block formats ("Dinhata - I")
create table if not exists public.service_request_gp (
  gp_id       smallint primary key references public.gram_panchayats(id),
  block_name  text
);
alter table public.service_request_gp enable row level security;
revoke all on public.service_request_gp from anon, authenticated;

-- ---------------------------------------------------------------- helpers
-- A valid Aadhaar number (12 digits, first 2–9, Verhoeff check digit) anywhere in the text?
create or replace function private.sr_has_aadhaar(p_text text)
returns boolean language plpgsql immutable set search_path to '' as $$
declare
  d int[] := array[0,1,2,3,4,5,6,7,8,9, 1,2,3,4,0,6,7,8,9,5, 2,3,4,0,1,7,8,9,5,6, 3,4,0,1,2,8,9,5,6,7, 4,0,1,2,3,9,5,6,7,8,
                   5,9,8,7,6,0,4,3,2,1, 6,5,9,8,7,1,0,4,3,2, 7,6,5,9,8,2,1,0,4,3, 8,7,6,5,9,3,2,1,0,4, 9,8,7,6,5,4,3,2,1,0];
  p int[] := array[0,1,2,3,4,5,6,7,8,9, 1,5,7,6,2,8,3,0,9,4, 5,8,0,3,7,9,6,1,4,2, 8,9,1,6,0,4,3,5,2,7,
                   9,4,5,3,1,2,6,8,7,0, 4,2,8,6,5,7,3,9,0,1, 2,7,9,3,8,0,6,4,1,5, 7,0,4,6,9,1,3,2,5,8];
  m text[]; s text; c int; i int;
begin
  if p_text is null or p_text !~ '\d' then return false; end if;
  -- 12 digits written together or as 4-4-4 with spaces / hyphens, not part of a longer number
  for m in select regexp_matches(p_text, '(?:^|[^0-9])([2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4})(?![0-9])', 'g') loop
    s := regexp_replace(m[1], '[^0-9]', '', 'g');
    if length(s) <> 12 then continue; end if;
    c := 0;
    for i in 0..11 loop
      c := d[c * 10 + p[(i % 8) * 10 + substr(s, 12 - i, 1)::int + 1] + 1];
    end loop;
    if c = 0 then return true; end if;
  end loop;
  return false;
end $$;

create or replace function private.sr_no_aadhaar(p_text text)
returns void language plpgsql immutable set search_path to '' as $$
begin
  if private.sr_has_aadhaar(p_text) then raise exception 'NO_AADHAAR' using errcode = '22023'; end if;
end $$;

create or replace function private.sr_is_super()
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.active and p.role = 'super_admin')
$$;

create or replace function private.sr_name(p_uid uuid)
returns text language sql stable security definer set search_path to '' as $$
  select coalesce(nullif(p.full_name, ''), p.username) from public.profiles p where p.user_id = p_uid
$$;

-- clean the free-text format fields: only known keys, short strings, no Aadhaar number
create or replace function private.sr_clean_details(p_kind text, p_details jsonb)
returns jsonb language plpgsql stable set search_path to '' as $$
declare v jsonb := '{}'::jsonb; k text; x jsonb; m jsonb; mem jsonb := '[]'::jsonb;
        keys text[] := array['reason', 'reason_text', 'shift_block', 'shift_gp', 'shift_jc', 'aadhaar_name', 'gender',
                             'right_worker_id', 'right_name', 'right_applicant_no', 'seeded', 'new_hoh', 'old_hoh', 'remarks'];
begin
  if p_details is null or jsonb_typeof(p_details) <> 'object' then return v; end if;
  foreach k in array keys loop
    x := p_details -> k;
    if x is null or jsonb_typeof(x) = 'null' then continue; end if;
    if jsonb_typeof(x) not in ('string', 'number') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    if length(btrim(x #>> '{}')) = 0 then continue; end if;
    v := v || jsonb_build_object(k, left(btrim(x #>> '{}'), 200));
  end loop;
  if p_kind = 'gender_hoh' and jsonb_typeof(p_details -> 'members') = 'array' then
    if jsonb_array_length(p_details -> 'members') > 30 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    for m in select * from jsonb_array_elements(p_details -> 'members') loop
      mem := mem || jsonb_build_array(jsonb_build_object(
        'name', left(btrim(coalesce(m ->> 'name', '')), 80), 'rel', left(btrim(coalesce(m ->> 'rel', '')), 40),
        'gender', left(btrim(coalesce(m ->> 'gender', '')), 12)));
    end loop;
    v := v || jsonb_build_object('members', mem);
  end if;
  perform private.sr_no_aadhaar(v::text);
  return v;
end $$;

-- one row → json (p_admin: Admin view; p_super: also the last 4 digits of a locked Aadhaar)
create or replace function private.sr_json(r public.service_requests, p_admin boolean, p_super boolean)
returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'title', r.title, 'note', r.note, 'details', r.details, 'status', r.status, 'remark', r.remark,
    'history', r.history, 'created_at', r.created_at, 'updated_at', r.updated_at, 'admin_at', r.admin_at, 'closed_at', r.closed_at,
    'ekyc_needed', r.ekyc_needed, 'ekyc_done_at', r.ekyc_done_at, 'by_admin', r.by_admin,
    'worker_id', r.worker_id, 'job_card_no', r.job_card_no, 'applicant_no', r.applicant_no, 'applicant_name', r.applicant_name,
    'village_no', r.village_no, 'household_no', r.household_no,
    'unseen', (not p_admin and r.admin_at is not null and r.admin_at > coalesce(r.seen_at, '-infinity'::timestamptz)))
  || case when p_admin then jsonb_build_object(
       'from_name', private.sr_name(r.created_by), 'for_user', r.for_user, 'for_name', private.sr_name(r.for_user),
       'has_aadhaar', p_super and exists (select 1 from public.service_request_secrets s where s.request_id = r.id),
       'aadhaar_last4', case when p_super then (select s.last4 from public.service_request_secrets s where s.request_id = r.id) end)
     else '{}'::jsonb end
$$;

-- shared insert (supervisor or Admin)
create or replace function private.sr_insert(p_gp smallint, p_worker_id bigint, p_kind text, p_title text, p_note text,
                                             p_details jsonb, p_for uuid, p_by uuid, p_admin boolean)
returns bigint language plpgsql security definer set search_path to '' as $$
declare w public.workers%rowtype; v_id bigint; v_title text := nullif(left(btrim(coalesce(p_title, '')), 120), '');
        v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), ''); v_det jsonb;
begin
  -- (Applicant / Job Card delete = the Expired / Migrant mark, bank account = Account copy request: they stay there)
  if p_kind is null or p_kind not in ('aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh',
                                      'applicant_add', 'payment', 'other', 'note') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_kind = 'other' and v_title is null then raise exception 'NEED_TITLE' using errcode = '22023'; end if;
  if p_kind = 'note' and v_note is null then raise exception 'NEED_NOTE' using errcode = '22023'; end if;
  if p_worker_id is not null or p_kind <> 'note' then        -- a note may be about nobody in particular
    select * into w from public.workers x where x.id = p_worker_id and x.gp_id = p_gp;
    if not found then raise exception 'WORKER_NOT_FOUND' using errcode = '22023'; end if;
  end if;
  perform private.sr_no_aadhaar(v_title); perform private.sr_no_aadhaar(v_note);
  v_det := private.sr_clean_details(p_kind, p_details);
  if exists (select 1 from public.service_requests q where q.worker_id = p_worker_id and q.kind = p_kind and p_kind not in ('other', 'note')
               and q.status not in ('done', 'rejected', 'cancelled')) then
    raise exception 'ALREADY_OPEN' using errcode = '22023';
  end if;
  insert into public.service_requests (gp_id, worker_id, job_card_no, applicant_no, applicant_name, village_no, household_no,
                                       kind, title, note, details, for_user, created_by, by_admin, admin_at, history)
  values (p_gp, w.id, w.job_card_no, w.applicant_no, w.applicant_name, w.village_no, w.household_no,
          p_kind, v_title, v_note, v_det, p_for, p_by, p_admin, case when p_admin then now() end,
          jsonb_build_array(jsonb_build_object('at', now(), 'st', 'new', 'by', private.sr_name(p_by))))
  returning id into v_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (p_by, p_gp, 'service_request_add', 'service_requests', v_id::text, jsonb_build_object('kind', p_kind, 'by_admin', p_admin));
  return v_id;
end $$;

-- delete locked Aadhaar numbers 30 days after a request is closed
create or replace function private.sr_purge()
returns void language sql security definer set search_path to '' as $$
  delete from public.service_request_secrets s using public.service_requests q
   where q.id = s.request_id and q.status in ('done', 'rejected', 'cancelled') and q.closed_at < now() - interval '30 days'
$$;

-- ---------------------------------------------------------------- supervisor
-- my requests: open ones, closed in the last 30 days, and Done ones still waiting for eKYC (90 days)
create or replace function public.sr_my_requests()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((select jsonb_agg(private.sr_json(q, false, false) order by q.updated_at desc)
    from public.service_requests q
    where q.gp_id = v_gp and q.for_user = auth.uid()
      and (q.status not in ('done', 'rejected', 'cancelled')
           or q.closed_at > now() - interval '30 days'
           or (q.status = 'done' and q.ekyc_needed and q.ekyc_done_at is null and q.closed_at > now() - interval '90 days'))), '[]'::jsonb);
end $$;

create or replace function public.sr_create(p_worker_id bigint, p_kind text, p_title text, p_note text, p_details jsonb)
returns bigint language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  if (select count(*) from public.service_requests q where q.for_user = auth.uid() and q.status in ('new', 'working', 'block', 'district')) >= 60 then
    raise exception 'TOO_MANY_REQUESTS' using errcode = '22023';
  end if;
  return private.sr_insert(v_gp, p_worker_id, p_kind, p_title, p_note, p_details, auth.uid(), auth.uid(), false);
end $$;

-- the supervisor cancels a request they wrote themselves while it is still New
create or replace function public.sr_cancel(p_id bigint)
returns void language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_n int;
begin
  update public.service_requests q
     set status = 'cancelled', closed_at = now(), updated_at = now(),
         history = q.history || jsonb_build_array(jsonb_build_object('at', now(), 'st', 'cancelled', 'by', private.sr_name(auth.uid())))
   where q.id = p_id and q.gp_id = v_gp and q.for_user = auth.uid() and q.created_by = auth.uid() and q.status = 'new';
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
end $$;

-- the supervisor opened the page: Admin changes are now seen
create or replace function public.sr_seen()
returns void language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  update public.service_requests q set seen_at = now()
   where q.gp_id = v_gp and q.for_user = auth.uid() and q.admin_at is not null and q.admin_at > coalesce(q.seen_at, '-infinity'::timestamptz);
end $$;

-- the supervisor read a note the Admin sent: "দেখেছি" closes it (the Admin sees Done + who)
create or replace function public.sr_ack(p_id bigint)
returns void language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_n int;
begin
  update public.service_requests q
     set status = 'done', closed_at = now(), updated_at = now(), seen_at = now(),
         history = q.history || jsonb_build_array(jsonb_build_object('at', now(), 'st', 'seen', 'by', private.sr_name(auth.uid())))
   where q.id = p_id and q.gp_id = v_gp and q.for_user = auth.uid() and q.kind = 'note' and q.by_admin
     and q.status not in ('done', 'rejected', 'cancelled');
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
end $$;

-- the supervisor says the worker's eKYC was done again
create or replace function public.sr_ekyc_done(p_id bigint)
returns void language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_n int;
begin
  update public.service_requests q
     set ekyc_done_at = now(), updated_at = now(),
         history = q.history || jsonb_build_array(jsonb_build_object('at', now(), 'st', 'ekyc', 'by', private.sr_name(auth.uid())))
   where q.id = p_id and q.gp_id = v_gp and q.for_user = auth.uid() and q.ekyc_needed and q.ekyc_done_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
end $$;

-- ---------------------------------------------------------------- Admin
-- page start: am I the Super Admin, is the Aadhaar lock set, Block name, supervisors of the GP
create or replace function public.admin_sr_meta(p_gp_id smallint)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_super boolean := private.sr_is_super();
begin
  return jsonb_build_object(
    'super', v_super,
    'lock', case when v_super then (select jsonb_build_object('salt', l.salt, 'check', l.check_ct, 'set_at', l.set_at) from public.service_request_lock l where l.id = 1) end,
    'block_name', (select s.block_name from public.service_request_gp s where s.gp_id = p_gp_id),
    'gp_name', (select g.name from public.gram_panchayats g where g.id = p_gp_id),
    'supervisors', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', coalesce(nullif(p.full_name, ''), p.username), 'username', p.username)
                              order by coalesce(nullif(p.full_name, ''), p.username))
                             from public.profiles p where p.role = 'gp_user' and p.gp_id = p_gp_id and p.active), '[]'::jsonb));
end $$;

create or replace function public.admin_service_requests(p_gp_id smallint, p_all boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_super boolean := private.sr_is_super();
begin
  perform private.sr_purge();
  return coalesce((select jsonb_agg(private.sr_json(q, true, v_super) order by q.created_at desc)
    from public.service_requests q
    where q.gp_id = p_gp_id
      and (q.status not in ('done', 'rejected', 'cancelled') or p_all or q.closed_at > now() - interval '7 days'
           or (q.status = 'done' and q.ekyc_needed and q.ekyc_done_at is null))), '[]'::jsonb);
end $$;

create or replace function public.admin_sr_count(p_gp_id smallint)
returns integer language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  return (select count(*)::int from public.service_requests q where q.gp_id = p_gp_id and q.status = 'new' and not q.by_admin);
end $$;

-- workers of a GP by Job Card ("16/98", full number) or name, with household for picking family members
create or replace function public.admin_sr_find(p_gp_id smallint, p_q text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); q text := btrim(coalesce(p_q, '')); v_m text[]; v_v int; v_h int; lk text;
begin
  if length(q) < 2 then return '[]'::jsonb; end if;
  v_m := regexp_match(q, '(\d{1,3})\s*/\s*(\d{1,4})\s*$');
  if v_m is not null then v_v := v_m[1]::int; v_h := v_m[2]::int; end if;
  lk := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return coalesce((select jsonb_agg(jsonb_build_object('worker_id', x.id, 'job_card_no', x.job_card_no, 'applicant_no', x.applicant_no,
            'applicant_name', x.applicant_name, 'village_no', x.village_no, 'household_no', x.household_no, 'active', x.active)
            order by x.village_no, x.household_no, x.applicant_no)
    from (select w.* from public.workers w
           where w.gp_id = p_gp_id
             and (case when v_v is not null then w.village_no = v_v and w.household_no = v_h
                       else w.applicant_name ilike lk or w.job_card_no ilike lk end)
           order by w.active desc, w.village_no, w.household_no, w.applicant_no limit 40) x), '[]'::jsonb);
end $$;

-- Admin writes a request (for a supervisor, or for nobody = Admin only)
create or replace function public.admin_sr_create(p_gp_id smallint, p_for uuid, p_worker_id bigint, p_kind text, p_title text,
                                                  p_note text, p_details jsonb)
returns bigint language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  if p_for is not null and not exists (select 1 from public.profiles p where p.user_id = p_for and p.role = 'gp_user' and p.gp_id = p_gp_id) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  return private.sr_insert(p_gp_id, p_worker_id, p_kind, p_title, p_note, p_details, p_for, v_uid, true);
end $$;

-- Admin corrects the format fields / note / supervisor of one request
create or replace function public.admin_sr_edit(p_id bigint, p_note text, p_details jsonb, p_for uuid default null, p_set_for boolean default false)
returns void language plpgsql security definer set search_path to '' as $$
declare r public.service_requests%rowtype; v_uid uuid; v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  select * into r from public.service_requests where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  v_uid := private.require_admin_gp(r.gp_id);
  perform private.sr_no_aadhaar(v_note);
  if p_set_for and p_for is not null and not exists (select 1 from public.profiles p where p.user_id = p_for and p.role = 'gp_user' and p.gp_id = r.gp_id) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  update public.service_requests q
     set note = v_note, details = private.sr_clean_details(r.kind, p_details), updated_at = now(),
         for_user = case when p_set_for then p_for else q.for_user end
   where q.id = p_id;
end $$;

-- Admin sets the status of one or more requests (all of one GP) with a remark
create or replace function public.admin_sr_set_status(p_ids bigint[], p_status text, p_remark text)
returns integer language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_uid uuid; v_n int; v_rm text := nullif(left(btrim(coalesce(p_remark, '')), 300), ''); v_by text;
begin
  if p_status is null or p_status not in ('new', 'working', 'block', 'district', 'done', 'rejected', 'cancelled') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_status = 'rejected' and v_rm is null then raise exception 'COMMENT_NEEDED' using errcode = '22023'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select case when count(distinct q.gp_id) = 1 and count(*) = cardinality(p_ids) then min(q.gp_id) else -1 end into v_gp
    from public.service_requests q where q.id = any (p_ids);
  v_uid := private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  perform private.sr_no_aadhaar(v_rm);
  v_by := private.sr_name(v_uid);
  update public.service_requests q
     set status = p_status, remark = v_rm, updated_at = now(), admin_at = now(),
         closed_at = case when p_status in ('done', 'rejected', 'cancelled') then coalesce(case when q.status = p_status then q.closed_at end, now()) end,
         ekyc_needed = case when p_status = 'done' and q.kind in ('aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh') then true
                            when p_status = 'done' then q.ekyc_needed else false end,
         ekyc_done_at = case when p_status = 'done' then q.ekyc_done_at end,
         history = q.history || jsonb_build_array(jsonb_build_object('at', now(), 'st', p_status, 'rm', v_rm, 'by', v_by))
   where q.id = any (p_ids);
  get diagnostics v_n = row_count;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'service_request_status', 'service_requests', null, jsonb_build_object('ids', to_jsonb(p_ids), 'status', p_status));
  return v_n;
end $$;

create or replace function public.admin_sr_set_block(p_gp_id smallint, p_block text)
returns void language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  insert into public.service_request_gp (gp_id, block_name) values (p_gp_id, nullif(left(btrim(coalesce(p_block, '')), 60), ''))
  on conflict (gp_id) do update set block_name = excluded.block_name;
end $$;

-- ---------------------------------------------------------------- Aadhaar lock (Super Admin only)
create or replace function private.sr_require_super()
returns uuid language plpgsql stable security definer set search_path to '' as $$
begin
  if private.admin_scope() is not null or not private.sr_is_super() then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return auth.uid();
end $$;

-- first time: store the salt + check text. p_reset = forgot the password: every locked number is deleted.
create or replace function public.admin_sr_lock_set(p_salt text, p_check text, p_reset boolean default false)
returns void language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.sr_require_super();
begin
  if coalesce(length(p_salt), 0) not between 16 and 200 or coalesce(length(p_check), 0) not between 20 and 400 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if exists (select 1 from public.service_request_lock) then
    if not p_reset then raise exception 'ALREADY_SET' using errcode = '22023'; end if;
    delete from public.service_request_secrets;
    delete from public.service_request_lock;
  end if;
  insert into public.service_request_lock (id, salt, check_ct, set_by) values (1, p_salt, p_check, v_uid);
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, null, case when p_reset then 'sr_lock_reset' else 'sr_lock_set' end, 'service_request_lock', '1', '{}'::jsonb);
end $$;

-- store (or with p_ct null: delete) the locked Aadhaar number(s) of one request
create or replace function public.admin_sr_aadhaar_set(p_id bigint, p_ct text, p_last4 text)
returns void language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.sr_require_super();
begin
  if not exists (select 1 from public.service_requests q where q.id = p_id
                  and q.kind in ('aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch')) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_ct is null then delete from public.service_request_secrets where request_id = p_id; return; end if;
  if not exists (select 1 from public.service_request_lock) then raise exception 'NO_LOCK' using errcode = '22023'; end if;
  -- the locked text must not be a readable number
  if p_ct ~ '[0-9]{12}' and private.sr_has_aadhaar(p_ct) then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  insert into public.service_request_secrets (request_id, ct, last4, set_by) values (p_id, p_ct, nullif(p_last4, ''), v_uid)
  on conflict (request_id) do update set ct = excluded.ct, last4 = excluded.last4, set_at = now(), set_by = excluded.set_by;
end $$;

-- locked texts of the chosen requests (opened in the browser with the password)
create or replace function public.admin_sr_aadhaar_get(p_ids bigint[])
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.sr_require_super();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.request_id, 'ct', s.ct))
                     from public.service_request_secrets s where s.request_id = any (coalesce(p_ids, '{}'))), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- rights
revoke all on function private.sr_has_aadhaar(text), private.sr_no_aadhaar(text), private.sr_is_super(), private.sr_name(uuid),
  private.sr_clean_details(text, jsonb), private.sr_json(public.service_requests, boolean, boolean),
  private.sr_insert(smallint, bigint, text, text, text, jsonb, uuid, uuid, boolean), private.sr_purge(), private.sr_require_super()
  from public, anon, authenticated;

revoke all on function public.sr_my_requests(), public.sr_create(bigint, text, text, text, jsonb), public.sr_cancel(bigint),
  public.sr_seen(), public.sr_ack(bigint), public.sr_ekyc_done(bigint), public.admin_sr_meta(smallint), public.admin_service_requests(smallint, boolean),
  public.admin_sr_count(smallint), public.admin_sr_find(smallint, text),
  public.admin_sr_create(smallint, uuid, bigint, text, text, text, jsonb), public.admin_sr_edit(bigint, text, jsonb, uuid, boolean),
  public.admin_sr_set_status(bigint[], text, text), public.admin_sr_set_block(smallint, text),
  public.admin_sr_lock_set(text, text, boolean), public.admin_sr_aadhaar_set(bigint, text, text), public.admin_sr_aadhaar_get(bigint[])
  from public, anon;
grant execute on function public.sr_my_requests(), public.sr_create(bigint, text, text, text, jsonb), public.sr_cancel(bigint),
  public.sr_seen(), public.sr_ack(bigint), public.sr_ekyc_done(bigint), public.admin_sr_meta(smallint), public.admin_service_requests(smallint, boolean),
  public.admin_sr_count(smallint), public.admin_sr_find(smallint, text),
  public.admin_sr_create(smallint, uuid, bigint, text, text, text, jsonb), public.admin_sr_edit(bigint, text, jsonb, uuid, boolean),
  public.admin_sr_set_status(bigint[], text, text), public.admin_sr_set_block(smallint, text),
  public.admin_sr_lock_set(text, text, boolean), public.admin_sr_aadhaar_set(bigint, text, text), public.admin_sr_aadhaar_get(bigint[])
  to authenticated;

select private.schema_mark(234, 'সেবা অনুরোধ: supervisor task requests + Block formats');

commit;

notify pgrst, 'reload schema';
