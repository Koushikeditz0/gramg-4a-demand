-- =====================================================================
-- G RAM-G 4A — v1.7.7: GP Admin role
--
-- A GP Admin manages ONE GP from the Admin panel: its lists, worker data
-- imports, supervisors and K-Desk login. Everything outside their GP is
-- refused by the database (not just hidden in the browser).
-- The Super Admin keeps full control, and is the only one who can add a
-- GP, create a GP Admin, or turn someone into a GP Admin.
--
-- Safe to run more than once. Run the whole file in the SQL Editor.
-- =====================================================================

-- 1. New role -----------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['super_admin', 'gp_admin', 'gp_user', 'kdesk']));
-- (profiles_gp_user_needs_gp already makes every non-super role carry a GP)

-- 2. Permission helpers ------------------------------------------------
-- Admin scope of the caller: NULL = Super Admin (all GPs), otherwise the
-- GP Admin's own GP. Anyone else is refused.
create or replace function private.admin_scope()
returns smallint language plpgsql stable security definer set search_path to '' as $$
declare v_p public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_LOGGED_IN' using errcode = '28000'; end if;
  if not private.session_ok() then raise exception 'SESSION_REVOKED' using errcode = '28000'; end if;
  select * into v_p from public.profiles where user_id = auth.uid() and active;
  if not found then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if v_p.role = 'super_admin' then return null; end if;
  if v_p.role = 'gp_admin' and v_p.gp_id is not null
     and exists (select 1 from public.gram_panchayats g where g.id = v_p.gp_id and g.active) then
    return v_p.gp_id;
  end if;
  raise exception 'NOT_AUTHORIZED' using errcode = '42501';
end $$;

-- Caller may manage this GP (Super Admin: any GP).
create or replace function private.require_admin_gp(p_gp smallint)
returns uuid language plpgsql stable security definer set search_path to '' as $$
declare v_scope smallint := private.admin_scope();
begin
  if v_scope is not null and v_scope is distinct from p_gp then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create or replace function private.require_admin_list(p_list_id uuid)
returns uuid language sql stable security definer set search_path to '' as $$
  select private.require_admin_gp(coalesce((select l.gp_id from public.demand_lists l where l.id = p_list_id), -1)::smallint)
$$;

create or replace function private.require_admin_job(p_job_id bigint)
returns uuid language sql stable security definer set search_path to '' as $$
  select private.require_admin_gp(coalesce((select j.gp_id from public.import_jobs j where j.id = p_job_id), -1)::smallint)
$$;

-- All lists must exist and be in one GP the caller manages.
create or replace function private.require_admin_lists(p_list_ids uuid[])
returns uuid language sql stable security definer set search_path to '' as $$
  select private.require_admin_gp((
    select case when count(distinct l.gp_id) = 1 and count(l.id) = count(*) then min(l.gp_id) else -1 end
    from unnest(coalesce(p_list_ids, '{}')) x left join public.demand_lists l on l.id = x)::smallint)
$$;

-- A GP Admin may manage only supervisors / K-Desk logins of their own GP.
create or replace function private.require_admin_user(p_user_id uuid)
returns uuid language sql stable security definer set search_path to '' as $$
  select private.require_admin_gp(coalesce((
    select case when p.role in ('gp_user', 'kdesk') then p.gp_id end
    from public.profiles p where p.user_id = p_user_id), -1)::smallint)
$$;

revoke all on function private.admin_scope(), private.require_admin_gp(smallint), private.require_admin_list(uuid),
  private.require_admin_job(bigint), private.require_admin_lists(uuid[]), private.require_admin_user(uuid) from public, anon;

-- 3. Swap the Super-Admin-only check for the GP check in the admin functions.
-- Each function's own code is read from the database and only its first
-- line (the permission check) changes; the rest stays exactly as it is.
do $$
declare
  m record; v_oid oid; v_def text; v_new text;
begin
  for m in select * from (values
    ('admin_dashboard',        'p_gp_id smallint',                                   'private.require_admin_gp(p_gp_id)'),
    ('admin_data_status',      'p_gp_id smallint',                                   'private.require_admin_gp(p_gp_id)'),
    ('admin_kdesk_activity',   'p_gp_id smallint, p_limit integer',                  'private.require_admin_gp(p_gp_id)'),
    ('admin_ekyc_report',      'p_gp_id smallint',                                   'private.require_admin_gp(p_gp_id)'),
    ('admin_list_duplicates',  'p_gp_id smallint',                                   'private.require_admin_gp(p_gp_id)'),
    ('admin_import_history',   'p_gp_id smallint',                                   'private.require_admin_gp(p_gp_id)'),
    ('admin_create_import',    'p_gp_id smallint, p_file_name text, p_file_sha256 text, p_deactivate_missing boolean', 'private.require_admin_gp(p_gp_id)'),
    ('admin_search_households','p_gp_id smallint, p_villages integer[], p_households integer[]', 'private.require_admin_gp(p_gp_id)'),
    ('admin_backup_workers',   'p_gp_id smallint, p_after_id bigint, p_limit integer', 'private.require_admin_gp(p_gp_id)'),
    ('admin_backup_lists',     'p_gp_id smallint, p_offset integer, p_limit integer', 'private.require_admin_gp(p_gp_id)'),
    ('admin_list_items',       'p_list_id uuid',                                     'private.require_admin_list(p_list_id)'),
    ('admin_list_submissions', 'p_list_id uuid',                                     'private.require_admin_list(p_list_id)'),
    ('admin_edit_list',        'p_list_id uuid, p_add bigint[], p_remove bigint[]',  'private.require_admin_list(p_list_id)'),
    ('admin_set_list_meta',    'p_list_id uuid, p_work_name text, p_supervisors text[]', 'private.require_admin_list(p_list_id)'),
    ('admin_set_list_state',   'p_list_id uuid, p_action text',                      'private.require_admin_list(p_list_id)'),
    ('admin_set_list_work_code','p_list_id uuid, p_work_code text',                  'private.require_admin_list(p_list_id)'),
    ('admin_stage_rows',       'p_job_id bigint, p_rows jsonb',                      'private.require_admin_job(p_job_id)'),
    ('admin_classify_import',  'p_job_id bigint',                                    'private.require_admin_job(p_job_id)'),
    ('admin_commit_import',    'p_job_id bigint',                                    'private.require_admin_job(p_job_id)'),
    ('admin_cancel_import',    'p_job_id bigint',                                    'private.require_admin_job(p_job_id)'),
    ('admin_rollback_import',  'p_job_id bigint',                                    'private.require_admin_job(p_job_id)'),
    ('admin_export_lists',     'p_list_ids uuid[]',                                  'private.require_admin_lists(p_list_ids)'),
    ('admin_set_user_active',  'p_user_id uuid, p_active boolean',                   'private.require_admin_user(p_user_id)'),
    ('admin_logout_user_everywhere', 'p_user_id uuid',                               'private.require_admin_user(p_user_id)'),
    ('admin_delete_user',      'p_user_id uuid, p_confirm_username text',            'private.require_admin_user(p_user_id)')
  ) t(fn, args, guard)
  loop
    select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = m.fn and pg_get_function_identity_arguments(p.oid) = m.args;
    if v_oid is null then raise exception 'function public.%(%) not found', m.fn, m.args; end if;
    v_def := pg_get_functiondef(v_oid);
    if position(m.guard in v_def) > 0 then continue; end if;          -- already done (re-run)
    if (select count(*) from regexp_matches(v_def, 'private\.require_super_admin\(\)', 'g')) <> 1 then
      raise exception 'public.%: expected exactly one Super Admin check', m.fn;
    end if;
    v_new := replace(v_def, 'private.require_super_admin()', m.guard);
    execute v_new;
  end loop;
end $$;

-- 4. Functions that change more than their first line ------------------

-- GP list: a GP Admin sees only their own GP.
create or replace function public.admin_list_gps()
returns table(id smallint, name text, jc_prefix text, workers bigint, active_workers bigint, accounts bigint)
language plpgsql stable security definer set search_path to '' as $$
#variable_conflict use_column
declare v_scope smallint := private.admin_scope();
begin
  return query
    select g.id, g.name, g.jc_prefix,
           (select count(*) from public.workers w where w.gp_id = g.id),
           (select count(*) from public.workers w where w.gp_id = g.id and w.active),
           (select count(*) from public.worker_accounts a join public.workers w on w.id = a.worker_id where w.gp_id = g.id)
    from public.gram_panchayats g where g.active and (v_scope is null or g.id = v_scope) order by g.id;
end $$;

-- Users: a GP Admin sees only the people of their own GP.
create or replace function public.admin_list_users()
returns table(user_id uuid, username text, full_name text, role text, gp_id smallint, gp_name text,
              active boolean, active_devices bigint, last_seen timestamp with time zone)
language plpgsql stable security definer set search_path to '' as $$
#variable_conflict use_column
declare v_scope smallint := private.admin_scope();
begin
  return query
    select p.user_id, p.username, p.full_name, p.role, p.gp_id, g.name, p.active,
           (select count(*) from public.device_sessions d where d.user_id = p.user_id and d.revoked_at is null),
           (select max(d.last_seen_at) from public.device_sessions d where d.user_id = p.user_id)
    from public.profiles p left join public.gram_panchayats g on g.id = p.gp_id
    where v_scope is null or p.gp_id = v_scope
    order by case p.role when 'super_admin' then 0 when 'gp_admin' then 1 when 'kdesk' then 2 else 3 end, p.username;
end $$;

-- Role change: Super Admin may also make / unmake a GP Admin.
-- A GP Admin may only switch their own GP's people between Supervisor and K-Desk.
create or replace function public.admin_set_user_role(p_user_id uuid, p_role text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_user(p_user_id); v_super boolean := private.admin_scope() is null;
        v_p public.profiles%rowtype; v_n integer;
begin
  if p_role not in ('gp_user', 'kdesk') and not (v_super and p_role = 'gp_admin') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_user_id = v_uid then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select * into v_p from public.profiles where user_id = p_user_id for update;
  if not found or v_p.role = 'super_admin' or v_p.gp_id is null then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update public.profiles set role = p_role, updated_at = now() where user_id = p_user_id;
  v_n := private.revoke_all_sessions(p_user_id, 'admin');
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_p.gp_id, 'role_changed', 'profiles', p_user_id::text, jsonb_build_object('from', v_p.role, 'to', p_role));
  return jsonb_build_object('role', p_role, 'sessions_revoked', v_n);
end $$;

-- After a PIN reset (called by the admin-users function): supervisors and
-- K-Desk logins; a GP Admin's PIN only by the Super Admin.
create or replace function public.admin_after_pin_reset(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_user(p_user_id); v_super boolean := private.admin_scope() is null;
        v_n integer; v_gp smallint;
begin
  select gp_id into v_gp from public.profiles
   where user_id = p_user_id and (role in ('gp_user', 'kdesk') or (v_super and role = 'gp_admin'));
  if not found then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  v_n := private.revoke_all_sessions(p_user_id, 'admin');
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'pin_reset', 'profiles', p_user_id::text, jsonb_build_object('sessions_revoked', v_n));
  return jsonb_build_object('sessions_revoked', v_n);
end $$;

-- New login's profile (called by the admin-users function right after it
-- creates the login). Supervisor / K-Desk in the caller's GP; a GP Admin
-- only by the Super Admin.
create or replace function public.admin_create_profile(p_user_id uuid, p_username text, p_full_name text,
                                                       p_role text, p_gp_id smallint)
returns void language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_super boolean := private.admin_scope() is null; v_email text;
begin
  if p_role not in ('gp_user', 'kdesk') and not (v_super and p_role = 'gp_admin') then
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
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'profile_created', 'profiles', p_user_id::text, jsonb_build_object('role', p_role));
end $$;

revoke all on function public.admin_create_profile(uuid, text, text, text, smallint) from public, anon;
grant execute on function public.admin_create_profile(uuid, text, text, text, smallint) to authenticated;

-- 5. Check: every admin function now has a permission check -------------
do $$
declare r record;
begin
  for r in select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'admin\_%' and p.prokind = 'f'
              and pg_get_functiondef(p.oid) !~ 'private\.(require_super_admin|require_admin_\w+|admin_scope)\('
  loop
    raise exception 'public.% has no admin check', r.proname;
  end loop;
end $$;

select 'GP Admin role ready' as result;
