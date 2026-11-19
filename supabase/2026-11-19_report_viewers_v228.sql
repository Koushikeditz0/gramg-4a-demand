-- =====================================================================
-- v228 · 📊 Report section + "Report viewer" login
--   • New role 'viewer' (GRS / STP / NS of a GP, or BDO / block staff):
--     logs in with username + PIN and sees ONLY the Report page.
--   • GP viewer = own GP only. Block viewer (only Super Admin can give it) = every GP.
--   • Report data only: MR pipeline, works, WL caste summary, eKYC/ABPS.
--     Never returns account no, IFSC, photos, Aadhaar flags, demand lists.
--   • Notes on any report row (MR / work / WL / worker / GP): shared with
--     everyone who can see that GP, or private ("শুধু আমি").
--   • Admins (Super / GP Admin) see the same report page + a few admin-only numbers.
-- Supabase dashboard → SQL Editor → paste all → Run.
-- After this, redeploy the admin-users Edge Function (it now allows role 'viewer').
-- =====================================================================

begin;

-- ---------- role ----------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['super_admin', 'gp_admin', 'gp_user', 'kdesk', 'viewer']));

-- ---------- viewer settings ----------
create table if not exists public.report_viewers (
  user_id     uuid primary key references public.profiles(user_id) on delete cascade,
  designation text check (designation is null or length(btrim(designation)) between 1 and 40),
  block       boolean not null default false,          -- true = every GP (block level)
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
alter table public.report_viewers enable row level security;
revoke all on public.report_viewers from anon, authenticated;

-- ---------- notes ----------
create table if not exists public.report_notes (
  id          bigserial primary key,
  gp_id       smallint not null references public.gram_panchayats(id),
  kind        text not null check (kind in ('mr', 'work', 'wl', 'worker', 'gp')),
  ref         text not null check (length(ref) between 1 and 80),
  body        text not null check (length(btrim(body)) between 1 and 500),
  private     boolean not null default false,
  created_by  uuid not null,
  author      text not null,                           -- name + designation at the time (kept if the user is deleted)
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid
);
create index if not exists report_notes_ref_idx on public.report_notes (gp_id, kind, ref) where deleted_at is null;
create index if not exists report_notes_new_idx on public.report_notes (gp_id, created_at desc) where deleted_at is null;
alter table public.report_notes enable row level security;
revoke all on public.report_notes from anon, authenticated;

-- ---------- who may see which GP ----------
create or replace function private.report_gps()
 returns smallint[] language plpgsql stable security definer set search_path to '' as $$
declare v_p public.profiles%rowtype; v_block boolean;
begin
  if auth.uid() is null then raise exception 'NOT_LOGGED_IN' using errcode = '28000'; end if;
  if not private.session_ok() then raise exception 'SESSION_REVOKED' using errcode = '28000'; end if;
  select * into v_p from public.profiles where user_id = auth.uid() and active;
  if not found then raise exception 'USER_DISABLED' using errcode = '28000'; end if;
  if v_p.role = 'viewer' then
    select r.block into v_block from public.report_viewers r where r.user_id = v_p.user_id;
  end if;
  if v_p.role = 'super_admin' or (v_p.role = 'viewer' and coalesce(v_block, false)) then
    return coalesce((select array_agg(g.id order by g.id) from public.gram_panchayats g where g.active), '{}');
  end if;
  if v_p.role in ('gp_admin', 'viewer') then
    return coalesce((select array_agg(g.id) from public.gram_panchayats g where g.id = v_p.gp_id and g.active), '{}');
  end if;
  raise exception 'NOT_AUTHORIZED' using errcode = '42501';
end $$;

create or replace function private.require_report_gp(p_gp smallint)
 returns uuid language plpgsql stable security definer set search_path to '' as $$
begin
  if p_gp is null or not (p_gp = any (private.report_gps())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create or replace function private.report_is_admin()
 returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.active and p.role in ('super_admin', 'gp_admin'))
$$;

-- ---------- admins may manage viewers like supervisors ----------
create or replace function private.require_admin_user(p_user_id uuid)
 returns uuid language sql stable security definer set search_path to '' as $$
  select private.require_admin_gp(coalesce((
    select case when p.role in ('gp_user', 'kdesk', 'viewer') then p.gp_id end
    from public.profiles p where p.user_id = p_user_id), -1)::smallint)
$$;

create or replace function public.admin_create_profile(p_user_id uuid, p_username text, p_full_name text, p_role text, p_gp_id smallint)
 returns void language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_super boolean := private.admin_scope() is null; v_email text;
begin
  if p_role not in ('gp_user', 'kdesk', 'viewer') and not (v_super and p_role = 'gp_admin') then
    raise exception 'BAD_INPUT' using errcode = '22023', hint = 'এই role দেওয়া যায় না';
  end if;
  if p_gp_id is null or not exists (select 1 from public.gram_panchayats where id = p_gp_id and active) then
    raise exception 'BAD_INPUT' using errcode = '22023', hint = 'GP পাওয়া যায়নি';
  end if;
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then raise exception 'BAD_INPUT' using errcode = '22023', hint = 'User পাওয়া যায়নি'; end if;
  if lower(v_email) <> lower(p_username) || '@users.gramg.invalid' then
    raise exception 'BAD_INPUT' using errcode = '22023', hint = 'Username আর email মিলছে না';
  end if;
  insert into public.profiles (user_id, username, full_name, role, gp_id)
  values (p_user_id, lower(p_username), btrim(p_full_name), p_role, p_gp_id);
  if p_role = 'viewer' then
    insert into public.report_viewers (user_id, updated_by) values (p_user_id, v_uid) on conflict (user_id) do nothing;
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'profile_created', 'profiles', p_user_id::text, jsonb_build_object('role', p_role));
end $$;

-- designation + GP / block. Block only by the Super Admin.
create or replace function public.admin_set_viewer(p_user_id uuid, p_designation text, p_block boolean)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_user(p_user_id); v_super boolean := private.admin_scope() is null; v_p public.profiles%rowtype;
begin
  select * into v_p from public.profiles where user_id = p_user_id;
  if not found or v_p.role <> 'viewer' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if coalesce(p_block, false) and not v_super then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  insert into public.report_viewers (user_id, designation, block, updated_at, updated_by)
  values (p_user_id, nullif(left(btrim(coalesce(p_designation, '')), 40), ''), coalesce(p_block, false), now(), v_uid)
  on conflict (user_id) do update set designation = excluded.designation, block = excluded.block,
                                      updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_p.gp_id, 'viewer_set', 'report_viewers', p_user_id::text,
          jsonb_build_object('designation', p_designation, 'block', coalesce(p_block, false)));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_list_viewers()
 returns table (user_id uuid, designation text, block boolean)
 language plpgsql stable security definer set search_path to '' as $$
#variable_conflict use_column
declare v_scope smallint := private.admin_scope();
begin
  return query select p.user_id, r.designation, coalesce(r.block, false)
    from public.profiles p left join public.report_viewers r on r.user_id = p.user_id
   where p.role = 'viewer' and (v_scope is null or p.gp_id = v_scope);
end $$;

-- ---------- report: who am I ----------
create or replace function public.report_context()
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gps smallint[] := private.report_gps(); v_p public.profiles%rowtype; v_r public.report_viewers%rowtype;
begin
  select * into v_p from public.profiles where user_id = auth.uid();
  select * into v_r from public.report_viewers where user_id = auth.uid();
  return jsonb_build_object(
    'username', v_p.username, 'full_name', v_p.full_name, 'role', v_p.role,
    'designation', v_r.designation, 'block', coalesce(v_r.block, false) or v_p.role = 'super_admin',
    'is_admin', v_p.role in ('super_admin', 'gp_admin'), 'today', private.iay_today(),
    'gps', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'jc_prefix', g.jc_prefix) order by g.name)
                       from public.gram_panchayats g where g.id = any (v_gps)), '[]'::jsonb));
end $$;

-- ---------- report: home numbers for every GP the caller can see ----------
create or replace function public.report_home()
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gps smallint[] := private.report_gps(); v_t date := private.iay_today(); v_admin boolean := private.report_is_admin();
        v_me uuid := auth.uid();
begin
  return coalesce((select jsonb_agg(x order by x->>'name') from (
    select jsonb_build_object(
      'id', g.id, 'name', g.name,
      'mr_at', (select s.at from public.pipeline_mr_syncs s where s.gp_id = g.id),
      'stages', coalesce((select jsonb_object_agg(c.s, jsonb_build_object('all', c.n_all, 'pba', c.n_pba, 'amt', c.amt))
                  from (select private.mr_stage(m, v_t) s, count(*) n_all, count(*) filter (where m.work_code ~* '/IAY/') n_pba,
                               coalesce(sum(m.total), 0) amt
                          from public.pipeline_mrs m where m.gp_id = g.id group by 1) c), '{}'::jsonb),
      'pba_tomorrow', (select count(*) from public.pipeline_mrs m where m.gp_id = g.id and m.work_code ~* '/IAY/'
                          and not m.filled and not m.zero and m.date_to = v_t + 1),
      'works_waiting', (select count(distinct m.work_code) from public.pipeline_mrs m where m.gp_id = g.id
                          and private.mr_stage(m, v_t) in ('fill_today', 'fill_pending', 'emb', 'verify', 'wl_pending')),
      'ekyc', (select jsonb_build_object('workers', count(*), 'ekyc', count(*) filter (where w.ekyc),
                                         'abps', count(*) filter (where w.abps), 'ready', count(*) filter (where w.eligible))
                 from public.workers w where w.gp_id = g.id and w.active),
      'abps_at', (select max(r.finished_at) from public.kdesk_sync_runs r where r.gp_id = g.id),
      'caste_at', (select max(b.created_at) from public.wl_caste_batches b where b.gp_id = g.id),
      'notes_7d', (select count(*) from public.report_notes n where n.gp_id = g.id and n.deleted_at is null
                     and (not n.private or n.created_by = v_me) and n.created_at > now() - interval '7 days'),
      'admin', case when v_admin then jsonb_build_object(
          'no_account', (select count(*) from public.workers w where w.gp_id = g.id and w.active
                           and not exists (select 1 from public.worker_accounts a where a.worker_id = w.id)),
          'account_requests', (select count(*) from public.account_requests a where a.gp_id = g.id and a.closed_at is null),
          'snap_at', (select max(s.seen_at) from public.pipeline_snaps s where s.gp_id = g.id)) end
    ) x
    from public.gram_panchayats g where g.id = any (v_gps)) t), '[]'::jsonb);
end $$;

-- ---------- report: MRs of one stage (or all waiting) ----------
create or replace function public.report_mrs(p_gp smallint, p_stage text default null)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_report_gp(p_gp); v_t date := private.iay_today();
begin
  if p_stage is not null and p_stage not in ('fill_today', 'fill_pending', 'emb', 'verify', 'wl_pending', 'running') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  return jsonb_build_object('today', v_t,
    'at', (select s.at from public.pipeline_mr_syncs s where s.gp_id = p_gp),
    'rows', coalesce((select jsonb_agg(r order by r->>'to', r->>'code') from (
      select jsonb_build_object('code', m.work_code, 'name', left(m.work_name, 120), 'mr', m.mr_no, 's', private.mr_stage(m, v_t),
               'from', m.date_from, 'to', m.date_to, 'meas', m.meas_date, 'verif', m.verif_date, 'amt', m.total,
               'pba', m.work_code ~* '/IAY/',
               'notes', (select count(*) from public.report_notes n where n.gp_id = p_gp and n.kind = 'mr' and n.ref = m.mr_no
                           and n.deleted_at is null and (not n.private or n.created_by = v_uid))) r
        from public.pipeline_mrs m
       where m.gp_id = p_gp
         and (case when p_stage is null then private.mr_stage(m, v_t) in ('fill_today', 'fill_pending', 'emb', 'verify', 'wl_pending')
                   else private.mr_stage(m, v_t) = p_stage end)
       limit 5000) x), '[]'::jsonb));
end $$;

-- ---------- report: work-wise MR summary ----------
create or replace function public.report_works(p_gp smallint)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_report_gp(p_gp); v_t date := private.iay_today();
begin
  return coalesce((select jsonb_agg(w order by (w->>'waiting')::int desc, w->>'code') from (
    select jsonb_build_object('code', c.code, 'name', c.name, 'pba', c.code ~* '/IAY/', 'mrs', c.mrs, 'running', c.running,
             'waiting', c.waiting, 'wl', c.wl, 'last_to', c.last_to, 'amt', c.amt,
             'notes', (select count(*) from public.report_notes n where n.gp_id = p_gp and n.kind = 'work' and n.ref = c.code
                         and n.deleted_at is null and (not n.private or n.created_by = v_uid))) w
      from (select m.work_code code, left(max(m.work_name), 120) name, count(*) mrs,
                   count(*) filter (where private.mr_stage(m, v_t) = 'running') running,
                   count(*) filter (where private.mr_stage(m, v_t) in ('fill_today', 'fill_pending', 'emb', 'verify', 'wl_pending')) waiting,
                   count(*) filter (where private.mr_stage(m, v_t) = 'wl_done') wl,
                   max(m.date_to) last_to,
                   coalesce(sum(m.total) filter (where private.mr_stage(m, v_t) = 'wl_pending'), 0) amt
              from public.pipeline_mrs m where m.gp_id = p_gp group by m.work_code) c
     limit 6000) x), '[]'::jsonb);
end $$;

-- ---------- report: WL caste money by month ----------
create or replace function public.report_caste(p_gp smallint)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_report_gp(p_gp);
begin
  return jsonb_build_object(
    'at', (select max(b.created_at) from public.wl_caste_batches b where b.gp_id = p_gp),
    'months', coalesce((select jsonb_agg(jsonb_build_object('fy', fy, 'month', mon, 'wls', wls, 'workers', wk,
                 'gen', gen, 'sc', sc, 'st', st, 'unknown', unk, 'amount', amt) order by fy desc, mon desc)
      from (select r.fy, to_char(r.wl_date, 'YYYY-MM') mon, count(*) wls, sum(r.workers) wk, sum(r.gen_amt) gen,
                   sum(r.sc_amt) sc, sum(r.st_amt) st, sum(r.unknown_amt) unk, sum(r.amount) amt
              from public.wl_caste_reports r where r.gp_id = p_gp group by 1, 2) m), '[]'::jsonb));
end $$;

-- ---------- report: eKYC / ABPS by village + who is not ready ----------
create or replace function public.report_ekyc(p_gp smallint)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_report_gp(p_gp);
begin
  return jsonb_build_object(
    'at', (select max(r.finished_at) from public.kdesk_sync_runs r where r.gp_id = p_gp),
    'villages', coalesce((select jsonb_agg(jsonb_build_object('village_no', v.village_no, 'name', vn.local_name, 'workers', v.n,
                   'ekyc', v.e, 'abps', v.a, 'ready', v.r) order by v.village_no)
      from (select w.village_no, count(*) n, count(*) filter (where w.ekyc) e, count(*) filter (where w.abps) a,
                   count(*) filter (where w.eligible) r
              from public.workers w where w.gp_id = p_gp and w.active group by w.village_no) v
      left join public.village_names vn on vn.gp_id = p_gp and vn.village_no = v.village_no), '[]'::jsonb),
    'not_ready', coalesce((select jsonb_agg(jsonb_build_object('jc', w.job_card_no, 'ap', w.applicant_no, 'name', w.applicant_name,
                   'village_no', w.village_no, 'ekyc', w.ekyc, 'abps', w.abps)
                   order by w.village_no, w.household_no, w.job_card_no, w.applicant_no)
      from public.workers w where w.gp_id = p_gp and w.active and not w.eligible), '[]'::jsonb));
end $$;

-- ---------- notes ----------
create or replace function public.report_notes(p_gp smallint, p_kind text default null, p_ref text default null, p_limit integer default 200)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_report_gp(p_gp); v_admin boolean := private.report_is_admin();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'ref', n.ref, 'body', n.body, 'private', n.private,
             'author', n.author, 'at', n.created_at, 'mine', n.created_by = v_uid, 'can_delete', n.created_by = v_uid or v_admin)
             order by n.created_at desc)
    from (select * from public.report_notes n
           where n.gp_id = p_gp and n.deleted_at is null and (not n.private or n.created_by = v_uid)
             and (p_kind is null or n.kind = p_kind) and (p_ref is null or n.ref = p_ref)
           order by n.created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 500)) n), '[]'::jsonb);
end $$;

create or replace function public.report_note_add(p_gp smallint, p_kind text, p_ref text, p_body text, p_private boolean default false)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_report_gp(p_gp); v_p public.profiles%rowtype; v_d text; v_id bigint;
begin
  if p_kind not in ('mr', 'work', 'wl', 'worker', 'gp') or length(btrim(coalesce(p_ref, ''))) not between 1 and 80
     or length(btrim(coalesce(p_body, ''))) not between 1 and 500 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if (select count(*) from public.report_notes n where n.created_by = v_uid and n.created_at > now() - interval '1 day') >= 300 then
    raise exception 'TOO_MANY_NOTES' using errcode = '22023';
  end if;
  select * into v_p from public.profiles where user_id = v_uid;
  select r.designation into v_d from public.report_viewers r where r.user_id = v_uid;
  v_d := coalesce(v_d, case v_p.role when 'super_admin' then 'Admin' when 'gp_admin' then 'GP Admin' end);
  insert into public.report_notes (gp_id, kind, ref, body, private, created_by, author)
  values (p_gp, p_kind, btrim(p_ref), btrim(p_body), coalesce(p_private, false), v_uid,
          left(v_p.full_name || coalesce(' · ' || v_d, ''), 140))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.report_note_delete(p_id bigint)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_n public.report_notes%rowtype; v_uid uuid;
begin
  select * into v_n from public.report_notes where id = p_id and deleted_at is null;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  v_uid := private.require_report_gp(v_n.gp_id);
  if v_n.created_by <> v_uid and not private.report_is_admin() then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  update public.report_notes set deleted_at = now(), deleted_by = v_uid where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- grants: logged-in users only ----------
do $$
declare f text;
begin
  foreach f in array array['public.report_context()', 'public.report_home()', 'public.report_mrs(smallint, text)',
    'public.report_works(smallint)', 'public.report_caste(smallint)', 'public.report_ekyc(smallint)',
    'public.report_notes(smallint, text, text, integer)', 'public.report_note_add(smallint, text, text, text, boolean)',
    'public.report_note_delete(bigint)', 'public.admin_set_viewer(uuid, text, boolean)', 'public.admin_list_viewers()']
  loop
    execute 'revoke all on function ' || f || ' from public, anon';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
  foreach f in array array['private.report_gps()', 'private.require_report_gp(smallint)', 'private.report_is_admin()']
  loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
end $$;

select private.schema_mark(228, 'Report section + Report viewer login + report notes');

commit;

notify pgrst, 'reload schema';
