-- =====================================================================
-- Gram Setu — Aadhaar collection + Expired / Migrant marks (v214, 2026-11-14)
--
-- 1. Aadhaar: workers whose Aadhaar is not seeded, or seeded but the
--    Authentication is not done (from K-Desk ABPS Sync), show in the
--    supervisor's eKYC/ABPS section as "🪪 Aadhaar চাই". The supervisor
--    sends a photo of the Aadhaar card + Aadhaar number + Name as per
--    Aadhaar + gender + consent. The Admin checks it (Verify / Return with a
--    comment), K-Desk enters it on the portal (BulkAadhaarUpdate.aspx) and
--    reports back. Each status is shown back to the supervisor.
--    Privacy: the full number is readable only by the Admin and the K-Desk
--    login; it is wiped when the work is done, or after 7 days at most (only
--    the last 4 digits stay). Photos are in R2 (file name "r2a...") and only
--    the Admin can open them; the Admin panel deletes them when done / old.
-- 2. Marks: a supervisor marks a worker as Expired (মৃত), Permanently
--    Migrant or Duplicate. Marked workers cannot be picked in a new Demand
--    list. The Admin accepts / returns them and downloads one Excel for the
--    deletion proposal on the portal.
--
-- Needs v183 (R2 photos) and v187 (ABPS section). Run once in Supabase →
-- SQL Editor. Safe to run again.
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.aadhaar_requests (
  id              bigint generated always as identity primary key,
  gp_id           smallint not null references public.gram_panchayats(id),
  worker_id       bigint not null references public.workers(id) on delete cascade,
  status          text not null default 'sent' check (status in ('sent', 'returned', 'verified', 'updated', 'closed')),
  aadhaar_no      text,                         -- full 12 digits; wiped when done / after 7 days
  aadhaar_last4   text,
  name_as_aadhaar text,
  gender          text check (gender in ('M', 'F', 'T')),
  consent         boolean not null default false,
  photo_path      text,
  comment         text,                         -- Admin / portal comment shown to the supervisor
  history         jsonb not null default '[]'::jsonb,
  sent_by         uuid,
  sent_at         timestamptz,
  admin_by        uuid,
  admin_at        timestamptz,
  portal_status   text check (portal_status in ('ok', 'fail')),
  portal_note     text,
  portal_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists aadhaar_requests_worker on public.aadhaar_requests (worker_id);
create index if not exists aadhaar_requests_gp on public.aadhaar_requests (gp_id, status);
alter table public.aadhaar_requests enable row level security;
revoke all on public.aadhaar_requests from anon, authenticated;

-- every Aadhaar photo ever uploaded (so replaced / old ones get deleted too)
create table if not exists public.aadhaar_photos (
  id          bigint generated always as identity primary key,
  gp_id       smallint not null,
  request_id  bigint references public.aadhaar_requests(id) on delete set null,
  path        text not null unique,
  size_bytes  integer,
  created_at  timestamptz not null default now(),
  purged_at   timestamptz
);
create index if not exists aadhaar_photos_gp on public.aadhaar_photos (gp_id) where purged_at is null;
alter table public.aadhaar_photos enable row level security;
revoke all on public.aadhaar_photos from anon, authenticated;

create table if not exists public.worker_marks (
  id          bigint generated always as identity primary key,
  gp_id       smallint not null references public.gram_panchayats(id),
  worker_id   bigint not null references public.workers(id) on delete cascade,
  reason      text not null check (reason in ('dead', 'migrant', 'duplicate')),
  when_text   text,
  note        text,
  status      text not null default 'new' check (status in ('new', 'accepted', 'sent_delete', 'returned', 'deleted')),
  admin_note  text,
  marked_by   uuid,
  marked_at   timestamptz not null default now(),
  admin_by    uuid,
  admin_at    timestamptz,
  updated_at  timestamptz not null default now()
);
create unique index if not exists worker_marks_worker on public.worker_marks (worker_id);
create index if not exists worker_marks_gp on public.worker_marks (gp_id, status);
alter table public.worker_marks enable row level security;
revoke all on public.worker_marks from anon, authenticated;

-- ---------- helpers ----------
-- Aadhaar check digit (Verhoeff), same rule as the portal page
create or replace function private.verhoeff_ok(p text)
returns boolean language plpgsql immutable set search_path to '' as $$
declare
  d int[] := array[0,1,2,3,4,5,6,7,8,9, 1,2,3,4,0,6,7,8,9,5, 2,3,4,0,1,7,8,9,5,6, 3,4,0,1,2,8,9,5,6,7, 4,0,1,2,3,9,5,6,7,8,
                   5,9,8,7,6,0,4,3,2,1, 6,5,9,8,7,1,0,4,3,2, 7,6,5,9,8,2,1,0,4,3, 8,7,6,5,9,3,2,1,0,4, 9,8,7,6,5,4,3,2,1,0];
  pm int[] := array[0,1,2,3,4,5,6,7,8,9, 1,5,7,6,2,8,3,0,9,4, 5,8,0,3,7,9,6,1,4,2, 8,9,1,6,0,4,3,5,2,7,
                    9,4,5,3,1,2,6,8,7,0, 4,2,8,6,5,7,3,9,0,1, 2,7,9,3,8,0,6,4,1,5, 7,0,4,6,9,1,3,2,5,8];
  c int := 0; i int; n int;
begin
  if p is null or p !~ '^[2-9][0-9]{11}$' then return false; end if;
  n := length(p);
  for i in 0 .. n - 1 loop
    c := d[c * 10 + pm[(i % 8) * 10 + substr(p, n - i, 1)::int + 1] + 1];
  end loop;
  return c = 0;
end $$;

-- name of a user for history / lists
create or replace function private.user_label(p_uid uuid)
returns text language sql stable security definer set search_path to '' as $$
  select coalesce(nullif(p.full_name, ''), p.username) from public.profiles p where p.user_id = p_uid
$$;

-- does this worker still need Aadhaar on the portal?
create or replace function private.aadhaar_needed(w public.workers)
returns boolean language sql immutable set search_path to '' as $$
  select w.active and not (coalesce(w.aadhaar_seeded, false) and coalesce(w.authentication_done, false))
$$;

-- wipe full numbers older than 7 days (request goes back to the supervisor)
create or replace function private.aadhaar_expire(p_gp smallint)
returns void language plpgsql security definer set search_path to '' as $$
begin
  update public.aadhaar_requests r
     set aadhaar_no = null, status = 'returned', updated_at = now(),
         comment = '৭ দিনে কাজ হয়নি, তথ্য মুছে ফেলা হয়েছে। আবার পাঠান।',
         history = r.history || jsonb_build_array(jsonb_build_object('at', now(), 's', 'returned', 'c', 'auto: 7 days', 'by', 'system'))
   where r.gp_id = p_gp and r.aadhaar_no is not null and r.status in ('sent', 'verified')
     and r.sent_at < now() - interval '7 days';
  update public.aadhaar_requests r set aadhaar_no = null
   where r.gp_id = p_gp and r.aadhaar_no is not null and r.status not in ('sent', 'verified');
end $$;

-- photo access: Aadhaar photos (file name r2a...) only for the Admin, never the supervisor after sending
create or replace function private.photo_access(p_name text, p_mode text)
returns boolean language plpgsql stable security definer set search_path to '' as $$
declare v_parts text[] := string_to_array(coalesce(p_name, ''), '/'); v_p public.profiles%rowtype; v_gp smallint;
begin
  if auth.uid() is null or array_length(v_parts, 1) <> 3 or v_parts[1] !~ '^\d{1,5}$' then return false; end if;
  if not private.session_ok() then return false; end if;
  select * into v_p from public.profiles where user_id = auth.uid() and active;
  if not found then return false; end if;
  v_gp := v_parts[1]::smallint;
  if p_mode = 'insert' then
    return v_p.role = 'gp_user' and v_p.gp_id = v_gp and v_parts[2] = auth.uid()::text
       and v_parts[3] ~ '^[A-Za-z0-9_-]{1,80}\.jpg$';
  end if;
  if v_p.role = 'super_admin' then return true; end if;
  if v_p.role = 'gp_admin' and v_p.gp_id = v_gp then return true; end if;
  if v_parts[3] ~ '^r2a' then return false; end if;           -- Aadhaar photo: Admin only
  return v_p.role = 'gp_user' and v_p.gp_id = v_gp and v_parts[2] = auth.uid()::text;
end $$;

-- ---------- supervisor: ABPS section (v187 + Aadhaar + marks) ----------
create or replace function public.get_abps_summary()
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('village_no', v, 'workers', n, 'abps', a, 'ekyc', e, 'both', b, 'aadhaar', aa, 'marked', mk) order by v)
    from (
      select w.village_no as v, count(*) as n,
             count(*) filter (where coalesce(w.abps, false)) as a,
             count(*) filter (where coalesce(w.ekyc, false)) as e,
             count(*) filter (where coalesce(w.abps, false) and coalesce(w.ekyc, false)) as b,
             count(*) filter (where private.aadhaar_needed(w) and m.id is null
                                and not exists (select 1 from public.aadhaar_requests r where r.worker_id = w.id
                                                  and r.status in ('sent', 'verified', 'updated'))) as aa,
             count(m.id) as mk
      from public.workers w
      left join public.worker_marks m on m.worker_id = w.id and m.status <> 'returned'
      where w.gp_id = v_gp and w.active
      group by w.village_no) s), '[]'::jsonb);
end $function$;

create or replace function public.get_abps_village(p_village integer)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'worker_id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no,
             'applicant_name', w.applicant_name, 'household_no', w.household_no,
             'abps', coalesce(w.abps, false), 'ekyc', coalesce(w.ekyc, false),
             'seeded', coalesce(w.aadhaar_seeded, false), 'auth', coalesce(w.authentication_done, false),
             'aa_need', private.aadhaar_needed(w),
             'aa', case when r.id is null then null else jsonb_build_object(
                     'status', r.status, 'comment', r.comment, 'last4', r.aadhaar_last4,
                     'name', r.name_as_aadhaar, 'at', coalesce(r.admin_at, r.sent_at), 'portal', r.portal_status) end,
             'mark', case when m.id is null then null else jsonb_build_object(
                     'reason', m.reason, 'status', m.status, 'when', m.when_text, 'note', m.note, 'admin_note', m.admin_note) end)
           order by w.household_no, w.applicant_no)
    from public.workers w
    left join public.aadhaar_requests r on r.worker_id = w.id and r.status <> 'closed'
    left join public.worker_marks m on m.worker_id = w.id
    where w.gp_id = v_gp and w.active and w.village_no = p_village
      and (not (coalesce(w.abps, false) and coalesce(w.ekyc, false)) or private.aadhaar_needed(w)
           or r.id is not null or m.id is not null)), '[]'::jsonb);
end $function$;

-- supervisor sends one worker's Aadhaar
create or replace function public.aadhaar_submit(p_worker_id bigint, p_aadhaar text, p_name text, p_gender text,
                                                 p_consent boolean, p_path text, p_size integer)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_uid uuid := auth.uid();
        v_no text := regexp_replace(coalesce(p_aadhaar, ''), '\D', '', 'g');
        v_name text := nullif(left(upper(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g')), 80), '');
        v_id bigint; v_old text;
begin
  if not exists (select 1 from public.workers w where w.id = p_worker_id and w.gp_id = v_gp and w.active) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if not private.verhoeff_ok(v_no) then raise exception 'BAD_AADHAAR' using errcode = '22023'; end if;
  if v_name is null or v_name !~ '^[A-Z][A-Z .()''-]*$' then raise exception 'BAD_NAME' using errcode = '22023'; end if;
  if coalesce(p_gender, '') not in ('M', 'F', 'T') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if not coalesce(p_consent, false) then raise exception 'NO_CONSENT' using errcode = '22023'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> v_gp::text or split_part(p_path, '/', 2) <> v_uid::text
     or split_part(p_path, '/', 3) !~ '^r2a[0-9]+_[A-Za-z0-9]+\.jpg$' then
    raise exception 'PHOTO_NOT_FOUND' using errcode = '22023';
  end if;
  if exists (select 1 from public.aadhaar_requests r where r.worker_id = p_worker_id and r.status = 'updated') then
    raise exception 'ALREADY_DONE' using errcode = '22023';
  end if;

  insert into public.aadhaar_requests as r (gp_id, worker_id, status, aadhaar_no, aadhaar_last4, name_as_aadhaar, gender, consent,
                                            photo_path, comment, sent_by, sent_at, portal_status, portal_note, portal_at, history, updated_at)
  values (v_gp, p_worker_id, 'sent', v_no, right(v_no, 4), v_name, p_gender, true, p_path, null, v_uid, now(), null, null, null,
          jsonb_build_array(jsonb_build_object('at', now(), 's', 'sent', 'by', private.user_label(v_uid))), now())
  on conflict (worker_id) do update
     set status = 'sent', aadhaar_no = excluded.aadhaar_no, aadhaar_last4 = excluded.aadhaar_last4,
         name_as_aadhaar = excluded.name_as_aadhaar, gender = excluded.gender, consent = true,
         photo_path = excluded.photo_path, comment = null, sent_by = v_uid, sent_at = now(),
         portal_status = null, portal_note = null, portal_at = null, updated_at = now(),
         history = r.history || excluded.history
  returning id into v_id;

  insert into public.aadhaar_photos (gp_id, request_id, path, size_bytes) values (v_gp, v_id, p_path, p_size)
  on conflict (path) do nothing;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'aadhaar_sent', 'workers', p_worker_id::text, jsonb_build_object('last4', right(v_no, 4)));
  return jsonb_build_object('id', v_id);
end $$;

-- supervisor marks a worker as Expired / Migrant / Duplicate (or takes the mark back)
create or replace function public.worker_mark(p_worker_id bigint, p_reason text, p_when text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_uid uuid := auth.uid(); v_st text;
begin
  if not exists (select 1 from public.workers w where w.id = p_worker_id and w.gp_id = v_gp) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select status into v_st from public.worker_marks where worker_id = p_worker_id;
  if p_reason is null or p_reason = '' then                                 -- take back
    if v_st is null then return jsonb_build_object('ok', true); end if;
    if v_st not in ('new', 'returned') then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
    delete from public.worker_marks where worker_id = p_worker_id;
  else
    if p_reason not in ('dead', 'migrant', 'duplicate') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    if v_st is not null and v_st not in ('new', 'returned') then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
    insert into public.worker_marks as m (gp_id, worker_id, reason, when_text, note, status, marked_by, marked_at, admin_note, updated_at)
    values (v_gp, p_worker_id, p_reason, nullif(left(trim(coalesce(p_when, '')), 40), ''), nullif(left(trim(coalesce(p_note, '')), 300), ''),
            'new', v_uid, now(), null, now())
    on conflict (worker_id) do update set reason = excluded.reason, when_text = excluded.when_text, note = excluded.note,
           status = 'new', marked_by = v_uid, marked_at = now(), admin_note = null, updated_at = now();
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, case when coalesce(p_reason, '') = '' then 'worker_unmark' else 'worker_mark' end, 'workers', p_worker_id::text,
          jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- worker ids that cannot be picked in a Demand list (marked, not returned)
create or replace function public.get_marked_workers()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((select jsonb_agg(m.worker_id) from public.worker_marks m
                    where m.gp_id = v_gp and m.status <> 'returned'), '[]'::jsonb);
end $$;

-- news for the supervisor app: what the Admin / portal did in the last 10 days
create or replace function public.get_aadhaar_news()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_uid uuid := auth.uid();
begin
  return coalesce((select jsonb_agg(x order by x->>'at' desc) from (
    select jsonb_build_object('kind', 'aa', 'worker_id', w.id, 'name', w.applicant_name, 'job_card_no', w.job_card_no,
                              'village_no', w.village_no, 'status', r.status, 'comment', r.comment,
                              'at', coalesce(r.admin_at, r.portal_at, r.updated_at), 'mine', r.sent_by = v_uid) as x
      from public.aadhaar_requests r join public.workers w on w.id = r.worker_id
     where r.gp_id = v_gp and r.status in ('returned', 'verified', 'updated')
       and coalesce(r.admin_at, r.portal_at, r.updated_at) > now() - interval '10 days'
    union all
    select jsonb_build_object('kind', 'mark', 'worker_id', w.id, 'name', w.applicant_name, 'job_card_no', w.job_card_no,
                              'village_no', w.village_no, 'status', m.status, 'reason', m.reason, 'comment', m.admin_note,
                              'at', m.admin_at, 'mine', m.marked_by = v_uid)
      from public.worker_marks m join public.workers w on w.id = m.worker_id
     where m.gp_id = v_gp and m.status <> 'new' and m.admin_at > now() - interval '10 days'
    limit 200) s), '[]'::jsonb);
end $$;

-- ---------- Admin ----------
create or replace function public.admin_aadhaar_list(p_gp_id smallint, p_filter text default 'sent')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  perform private.aadhaar_expire(p_gp_id);
  return jsonb_build_object(
    'counts', (select jsonb_build_object(
        'sent', count(*) filter (where status = 'sent'),
        'verified', count(*) filter (where status = 'verified'),
        'returned', count(*) filter (where status = 'returned'),
        'updated', count(*) filter (where status = 'updated'),
        'fail', count(*) filter (where status = 'verified' and portal_status = 'fail'))
      from public.aadhaar_requests where gp_id = p_gp_id),
    'need', (select count(*) from public.workers w where w.gp_id = p_gp_id and private.aadhaar_needed(w)),
    'need_seeded', (select count(*) from public.workers w where w.gp_id = p_gp_id and private.aadhaar_needed(w) and coalesce(w.aadhaar_seeded, false)),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'status', r.status, 'aadhaar_no', r.aadhaar_no, 'last4', r.aadhaar_last4, 'name_as_aadhaar', r.name_as_aadhaar,
        'gender', r.gender, 'consent', r.consent, 'photo_path', case when p.purged_at is null then r.photo_path end,
        'comment', r.comment, 'history', r.history, 'sent_at', r.sent_at, 'sent_by', private.user_label(r.sent_by),
        'admin_at', r.admin_at, 'portal_status', r.portal_status, 'portal_note', r.portal_note, 'portal_at', r.portal_at,
        'worker_id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
        'village_no', w.village_no, 'seeded', coalesce(w.aadhaar_seeded, false), 'auth', coalesce(w.authentication_done, false))
        order by r.sent_at desc nulls last)
      from public.aadhaar_requests r
      join public.workers w on w.id = r.worker_id
      left join public.aadhaar_photos p on p.path = r.photo_path
      where r.gp_id = p_gp_id
        and (p_filter = 'all' or r.status = p_filter
             or (p_filter = 'fail' and r.status = 'verified' and r.portal_status = 'fail'))
        and (r.status not in ('updated', 'closed') or r.updated_at > now() - interval '30 days')), '[]'::jsonb));
end $$;

-- p_status: verified | returned (comment needed) | updated (done on portal) | closed (cancel)
--           | comment (only saves the comment, status stays)
create or replace function public.admin_aadhaar_set(p_ids bigint[], p_status text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid; v_gp smallint; v_n int; v_c text := nullif(left(trim(coalesce(p_comment, '')), 300), '');
begin
  select case when count(distinct gp_id) = 1 then min(gp_id) else -1 end into v_gp
    from public.aadhaar_requests where id = any (coalesce(p_ids, '{}'));
  v_uid := private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  if coalesce(p_status, '') not in ('verified', 'returned', 'updated', 'closed', 'comment') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if p_status in ('returned', 'comment') and v_c is null then raise exception 'COMMENT_NEEDED' using errcode = '22023'; end if;
  update public.aadhaar_requests r
     set status = case when p_status = 'comment' then r.status else p_status end,
         comment = case when p_status in ('returned', 'updated', 'closed', 'comment') then v_c else coalesce(v_c, r.comment) end,
         aadhaar_no = case when p_status in ('verified', 'comment') then r.aadhaar_no else null end,
         portal_status = case when p_status = 'verified' and r.status <> 'verified' then null else r.portal_status end,
         admin_by = v_uid, admin_at = now(), updated_at = now(),
         history = r.history || jsonb_build_array(jsonb_build_object('at', now(), 's', p_status, 'c', v_c, 'by', private.user_label(v_uid)))
   where r.id = any (p_ids) and r.status <> 'closed'
     and (p_status <> 'verified' or r.aadhaar_no is not null);
  get diagnostics v_n = row_count;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'aadhaar_' || p_status, 'aadhaar_requests', array_to_string(p_ids, ','), jsonb_build_object('n', v_n, 'comment', v_c));
  return jsonb_build_object('changed', v_n);
end $$;

-- photos to delete: request done / returned / closed, replaced, or older than 7 days
create or replace function public.admin_aadhaar_cleanup(p_gp_id smallint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  perform private.aadhaar_expire(p_gp_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'path', p.path))
    from public.aadhaar_photos p
    left join public.aadhaar_requests r on r.id = p.request_id
    where p.gp_id = p_gp_id and p.purged_at is null
      and (r.id is null or r.photo_path is distinct from p.path or r.status in ('updated', 'closed', 'returned')
           or p.created_at < now() - interval '7 days')), '[]'::jsonb);
end $$;

create or replace function public.admin_aadhaar_purged(p_ids bigint[])
returns integer language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_n integer;
begin
  select case when count(distinct gp_id) = 1 then min(gp_id) else -1 end into v_gp
    from public.aadhaar_photos where id = any (coalesce(p_ids, '{}'));
  perform private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  update public.aadhaar_photos set purged_at = now() where id = any (p_ids) and purged_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.admin_marks_list(p_gp_id smallint, p_filter text default 'new')
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  return jsonb_build_object(
    'counts', (select jsonb_build_object(
        'new', count(*) filter (where status = 'new'), 'accepted', count(*) filter (where status = 'accepted'),
        'sent_delete', count(*) filter (where status = 'sent_delete'), 'returned', count(*) filter (where status = 'returned'),
        'deleted', count(*) filter (where status = 'deleted'))
      from public.worker_marks where gp_id = p_gp_id),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'status', m.status, 'reason', m.reason, 'when', m.when_text, 'note', m.note, 'admin_note', m.admin_note,
        'marked_at', m.marked_at, 'marked_by', private.user_label(m.marked_by), 'admin_at', m.admin_at,
        'worker_id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
        'village_no', w.village_no, 'active', w.active) order by w.village_no, w.household_no, w.applicant_no)
      from public.worker_marks m join public.workers w on w.id = m.worker_id
      where m.gp_id = p_gp_id and (p_filter = 'all' or m.status = p_filter)), '[]'::jsonb));
end $$;

-- p_status: accepted | sent_delete | returned (note needed) | deleted
create or replace function public.admin_marks_set(p_ids bigint[], p_status text, p_note text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid; v_gp smallint; v_n int; v_c text := nullif(left(trim(coalesce(p_note, '')), 300), '');
begin
  select case when count(distinct gp_id) = 1 then min(gp_id) else -1 end into v_gp
    from public.worker_marks where id = any (coalesce(p_ids, '{}'));
  v_uid := private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  if coalesce(p_status, '') not in ('accepted', 'sent_delete', 'returned', 'deleted') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if p_status = 'returned' and v_c is null then raise exception 'COMMENT_NEEDED' using errcode = '22023'; end if;
  update public.worker_marks m set status = p_status, admin_note = coalesce(v_c, case when p_status = 'returned' then null else m.admin_note end),
         admin_by = v_uid, admin_at = now(), updated_at = now()
   where m.id = any (p_ids);
  get diagnostics v_n = row_count;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'worker_mark_' || p_status, 'worker_marks', array_to_string(p_ids, ','), jsonb_build_object('n', v_n, 'note', v_c));
  return jsonb_build_object('changed', v_n);
end $$;

-- ---------- K-Desk (BulkAadhaarUpdate.aspx helper) ----------
-- p_include_sent = also those the Admin has not verified yet
create or replace function public.kdesk_aadhaar_pending(p_include_sent boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk();
begin
  perform private.aadhaar_expire(v_gp);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'jc', w.job_card_no, 'ap', w.applicant_no, 'name', w.applicant_name, 'village_no', w.village_no,
      'uid', r.aadhaar_no, 'aname', r.name_as_aadhaar, 'gender', r.gender, 'status', r.status,
      'portal_status', r.portal_status, 'portal_note', r.portal_note)
      order by w.village_no, w.household_no, w.job_card_no, w.applicant_no)
    from public.aadhaar_requests r join public.workers w on w.id = r.worker_id
    where r.gp_id = v_gp and r.aadhaar_no is not null
      and (r.status = 'verified' or (p_include_sent and r.status = 'sent'))), '[]'::jsonb);
end $$;

-- p_rows = [{"id": 12, "s": "ok"|"fail", "m": "portal message"}]
create or replace function public.kdesk_aadhaar_report(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_uid uuid := auth.uid(); r jsonb; v_n int; v_ok int := 0; v_fail int := 0; v_m text;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'s', '') not in ('ok', 'fail') or coalesce(r->>'id', '') !~ '^[0-9]{1,18}$' then continue; end if;
    v_m := nullif(left(coalesce(r->>'m', ''), 300), '');
    if r->>'s' = 'ok' then
      update public.aadhaar_requests q set status = 'updated', aadhaar_no = null, portal_status = 'ok', portal_note = v_m, portal_at = now(),
             comment = null, updated_at = now(),
             history = q.history || jsonb_build_array(jsonb_build_object('at', now(), 's', 'updated', 'c', 'Portal: ' || coalesce(v_m, 'saved'), 'by', 'K-Desk'))
       where q.id = (r->>'id')::bigint and q.gp_id = v_gp and q.status in ('sent', 'verified');
      get diagnostics v_n = row_count; v_ok := v_ok + v_n;
    else
      -- stays with the Admin (status verified + portal fail); the Admin decides Return / fix
      update public.aadhaar_requests q set status = 'verified', portal_status = 'fail', portal_note = v_m, portal_at = now(),
             comment = coalesce(v_m, q.comment), updated_at = now(),
             history = q.history || jsonb_build_array(jsonb_build_object('at', now(), 's', 'fail', 'c', v_m, 'by', 'K-Desk'))
       where q.id = (r->>'id')::bigint and q.gp_id = v_gp and q.status in ('sent', 'verified');
      get diagnostics v_n = row_count; v_fail := v_fail + v_n;
    end if;
  end loop;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'aadhaar_portal_report', 'aadhaar_requests', null, jsonb_build_object('ok', v_ok, 'fail', v_fail));
  return jsonb_build_object('ok', v_ok, 'fail', v_fail);
end $$;

-- ---------- ABPS Sync says Authentication = Yes → the request is done ----------
create or replace function private.aadhaar_auth_done()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if coalesce(new.authentication_done, false) and coalesce(new.aadhaar_seeded, false)
     and not (coalesce(old.authentication_done, false) and coalesce(old.aadhaar_seeded, false)) then
    update public.aadhaar_requests q set status = 'updated', aadhaar_no = null, comment = null, updated_at = now(),
           admin_at = now(),
           history = q.history || jsonb_build_array(jsonb_build_object('at', now(), 's', 'updated', 'c', 'ABPS Sync: Authentication Yes', 'by', 'K-Desk'))
     where q.worker_id = new.id and q.status in ('sent', 'verified', 'returned');
  end if;
  return new;
end $$;
drop trigger if exists workers_aadhaar_auth_done on public.workers;
create trigger workers_aadhaar_auth_done after update of authentication_done, aadhaar_seeded on public.workers
  for each row execute function private.aadhaar_auth_done();

-- ---------- grants ----------
revoke all on function private.verhoeff_ok(text), private.user_label(uuid), private.aadhaar_needed(public.workers),
                       private.aadhaar_expire(smallint), private.aadhaar_auth_done() from public, anon, authenticated;
revoke all on function public.get_abps_summary(), public.get_abps_village(integer),
  public.aadhaar_submit(bigint, text, text, text, boolean, text, integer), public.worker_mark(bigint, text, text, text),
  public.get_marked_workers(), public.get_aadhaar_news(),
  public.admin_aadhaar_list(smallint, text), public.admin_aadhaar_set(bigint[], text, text),
  public.admin_aadhaar_cleanup(smallint), public.admin_aadhaar_purged(bigint[]),
  public.admin_marks_list(smallint, text), public.admin_marks_set(bigint[], text, text),
  public.kdesk_aadhaar_pending(boolean), public.kdesk_aadhaar_report(jsonb) from public, anon;
grant execute on function public.get_abps_summary(), public.get_abps_village(integer),
  public.aadhaar_submit(bigint, text, text, text, boolean, text, integer), public.worker_mark(bigint, text, text, text),
  public.get_marked_workers(), public.get_aadhaar_news(),
  public.admin_aadhaar_list(smallint, text), public.admin_aadhaar_set(bigint[], text, text),
  public.admin_aadhaar_cleanup(smallint), public.admin_aadhaar_purged(bigint[]),
  public.admin_marks_list(smallint, text), public.admin_marks_set(bigint[], text, text),
  public.kdesk_aadhaar_pending(boolean), public.kdesk_aadhaar_report(jsonb) to authenticated;

select 'OK: Aadhaar collection + Expired/Migrant marks (v214) installed' as result;
