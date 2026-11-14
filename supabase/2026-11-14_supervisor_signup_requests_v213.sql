-- =====================================================================
-- Gram Setu — Supervisor account requests with Admin approval (v213, 2026-11-14)
--
-- The login page stays exactly as it is. Instead the Admin / GP Admin turns on a
-- REQUEST LINK for a GP (Admin panel → 🙋 Requests). Only people who open that link
-- (or scan its QR) see the request page v2/join.html:
--   1. the page shows the GP's supervisor list (Works & Supervisors, v185);
--      the supervisor picks their own name,
--   2. enters their mobile number (= username) and a PIN,
--   3. the Edge Function "admin-users" (action request_account) creates the login
--      BANNED (cannot log in) and saves a pending request here. The PIN is kept
--      only by Supabase Auth (hashed), never in our tables.
--   4. Admin Accept → profile (Supervisor) + login un-banned + supervisor row linked.
--      Admin Reject → the login is deleted.
--
-- Limits against abuse: wrong link codes 10 per hour per IP, requests 5 per hour
-- per IP, one pending request per supervisor, 20 pending per GP, a pending request
-- older than 7 days is removed (with its login).
--
-- Needs v185 (gp_supervisors). Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.signup_links (
  gp_id smallint primary key references public.gram_panchayats(id),
  code text not null unique check (code ~ '^[a-z0-9]{12}$'),
  active boolean not null default true,
  expires_at timestamptz not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.signup_links enable row level security;
revoke all on public.signup_links from anon, authenticated;

create table if not exists public.account_requests (
  id bigint generated always as identity primary key,
  gp_id smallint not null references public.gram_panchayats(id),
  supervisor_id bigint references public.gp_supervisors(id) on delete set null,
  sup_name text not null,
  sup_code text not null,
  username text not null,
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'expired')),
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null
);
create unique index if not exists account_requests_one_pending_sup on public.account_requests (supervisor_id) where status = 'pending';
create unique index if not exists account_requests_one_pending_user on public.account_requests (username) where status = 'pending';
create index if not exists account_requests_gp on public.account_requests (gp_id, status, created_at desc);
alter table public.account_requests enable row level security;
revoke all on public.account_requests from anon, authenticated;

create table if not exists public.signup_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  kind text not null check (kind in ('bad_code', 'request')),
  at timestamptz not null default now()
);
create index if not exists signup_attempts_ip on public.signup_attempts (ip, kind, at);
alter table public.signup_attempts enable row level security;
revoke all on public.signup_attempts from anon, authenticated;

-- which login belongs to which supervisor (set on Accept)
alter table public.gp_supervisors add column if not exists user_id uuid references auth.users(id) on delete set null;

-- ---------- internal helpers ----------
-- Pending requests older than 7 days: marked expired, their (banned) login deleted.
create or replace function private.signup_expire()
returns integer language plpgsql security definer set search_path to '' as $$
declare v_ids uuid[]; v_n integer;
begin
  with x as (
    update public.account_requests set status = 'expired', decided_at = now()
     where status = 'pending' and created_at < now() - interval '7 days'
    returning user_id)
  select array_agg(user_id) into v_ids from x where user_id is not null;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n > 0 then
    -- only logins that never got a profile (never accepted)
    delete from auth.users u where u.id = any(v_ids)
      and not exists (select 1 from public.profiles p where p.user_id = u.id);
  end if;
  delete from public.signup_attempts where at < now() - interval '1 day';
  return v_n;
end $$;

-- Valid link → its GP, else NULL (and the wrong try is counted for the IP).
create or replace function private.signup_gp(p_code text, p_ip text)
returns smallint language plpgsql security definer set search_path to '' as $$
declare v_gp smallint;
begin
  select l.gp_id into v_gp from public.signup_links l join public.gram_panchayats g on g.id = l.gp_id
   where l.code = lower(btrim(coalesce(p_code, ''))) and l.active and l.expires_at > now() and g.active;
  if v_gp is null then
    insert into public.signup_attempts (ip, kind) values (left(coalesce(p_ip, '?'), 64), 'bad_code');
  end if;
  return v_gp;
end $$;

create or replace function private.signup_blocked(p_ip text, p_kind text, p_max integer)
returns boolean language sql stable security definer set search_path to '' as $$
  select count(*) >= p_max from public.signup_attempts
   where ip = left(coalesce(p_ip, '?'), 64) and kind = p_kind and at > now() - interval '1 hour'
$$;

revoke all on function private.signup_expire(), private.signup_gp(text, text), private.signup_blocked(text, text, integer)
  from public, anon, authenticated;

-- ---------- called ONLY by the Edge Function (secret key = service_role) ----------
-- Errors are returned as {"error": "..."} (not raised) so the counting of wrong
-- tries is kept.

-- Link opened: GP name + its supervisors (taken = already has a login / a pending request).
create or replace function public.signup_check_link(p_code text, p_ip text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint;
begin
  perform private.signup_expire();
  if private.signup_blocked(p_ip, 'bad_code', 10) then return jsonb_build_object('error', 'RATE_LIMIT'); end if;
  v_gp := private.signup_gp(p_code, p_ip);
  if v_gp is null then return jsonb_build_object('error', 'BAD_LINK'); end if;
  return jsonb_build_object(
    'gp_name', (select g.name from public.gram_panchayats g where g.id = v_gp),
    'supervisors', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'sup_id', s.sup_id,
                       'taken', s.user_id is not null or exists (select 1 from public.account_requests r
                                  where r.supervisor_id = s.id and r.status = 'pending'))
                     order by lower(s.name))
                   from public.gp_supervisors s where s.gp_id = v_gp and s.active), '[]'::jsonb));
end $$;

-- Before the login is created: may this request go ahead?
-- p_user_id NULL = only check; with p_user_id = save the pending request.
create or replace function public.signup_request(p_code text, p_supervisor_id bigint, p_username text,
                                                 p_ip text, p_user_agent text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_s public.gp_supervisors%rowtype; v_user text := lower(btrim(coalesce(p_username, ''))); v_id bigint;
begin
  if p_user_id is null then
    perform private.signup_expire();
    if private.signup_blocked(p_ip, 'bad_code', 10) or private.signup_blocked(p_ip, 'request', 5) then
      return jsonb_build_object('error', 'RATE_LIMIT');
    end if;
  end if;
  v_gp := private.signup_gp(p_code, p_ip);
  if v_gp is null then return jsonb_build_object('error', 'BAD_LINK'); end if;
  if v_user !~ '^[6-9][0-9]{9}$' then return jsonb_build_object('error', 'BAD_MOBILE'); end if;
  select * into v_s from public.gp_supervisors where id = p_supervisor_id and gp_id = v_gp and active;
  if not found then return jsonb_build_object('error', 'BAD_SUPERVISOR'); end if;
  if v_s.user_id is not null then return jsonb_build_object('error', 'SUPERVISOR_HAS_LOGIN'); end if;
  if exists (select 1 from public.account_requests where supervisor_id = v_s.id and status = 'pending') then
    return jsonb_build_object('error', 'ALREADY_REQUESTED');
  end if;
  if exists (select 1 from public.profiles where username = v_user)
     or exists (select 1 from public.account_requests where username = v_user and status = 'pending') then
    return jsonb_build_object('error', 'USERNAME_TAKEN');
  end if;
  if (select count(*) from public.account_requests where gp_id = v_gp and status = 'pending') >= 20 then
    return jsonb_build_object('error', 'TOO_MANY_PENDING');
  end if;
  if p_user_id is null then
    return jsonb_build_object('ok', true, 'gp_id', v_gp, 'name', v_s.name, 'sup_id', v_s.sup_id);
  end if;
  if not exists (select 1 from auth.users where id = p_user_id and lower(email) = v_user || '@users.gramg.invalid') then
    return jsonb_build_object('error', 'BAD_INPUT');
  end if;
  insert into public.account_requests (gp_id, supervisor_id, sup_name, sup_code, username, user_id, ip, user_agent)
  values (v_gp, v_s.id, v_s.name, v_s.sup_id, v_user, p_user_id, left(coalesce(p_ip, ''), 64), left(coalesce(p_user_agent, ''), 300))
  returning id into v_id;
  insert into public.signup_attempts (ip, kind) values (left(coalesce(p_ip, '?'), 64), 'request');
  return jsonb_build_object('ok', true, 'request_id', v_id, 'name', v_s.name);
exception when unique_violation then
  return jsonb_build_object('error', 'ALREADY_REQUESTED');
end $$;

revoke all on function public.signup_check_link(text, text), public.signup_request(text, bigint, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.signup_check_link(text, text), public.signup_request(text, bigint, text, text, text, uuid)
  to service_role;

-- ---------- Admin / GP Admin ----------
create or replace function public.admin_get_signup_link(p_gp_id smallint)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r public.signup_links%rowtype;
begin
  perform private.require_admin_gp(p_gp_id);
  select * into r from public.signup_links where gp_id = p_gp_id;
  if not found then return null; end if;
  return jsonb_build_object('code', r.code, 'active', r.active and r.expires_at > now(), 'expires_at', r.expires_at);
end $$;

-- p_action: 'new' = new code (the old link stops working), 'off' = turn off
create or replace function public.admin_set_signup_link(p_gp_id smallint, p_action text, p_days integer)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_code text; v_days integer := least(greatest(coalesce(p_days, 7), 1), 30);
begin
  if p_action = 'off' then
    update public.signup_links set active = false where gp_id = p_gp_id;
  elsif p_action = 'new' then
    v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
    insert into public.signup_links (gp_id, code, active, expires_at, created_by)
    values (p_gp_id, v_code, true, now() + make_interval(days => v_days), v_uid)
    on conflict (gp_id) do update set code = excluded.code, active = true, expires_at = excluded.expires_at,
                                      created_by = excluded.created_by, created_at = now();
  else
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'signup_link_' || p_action, 'signup_links', p_gp_id::text, jsonb_build_object('days', v_days));
  return public.admin_get_signup_link(p_gp_id);
end $$;

-- Pending requests + the last 14 days' decisions.
create or replace function public.admin_list_account_requests(p_gp_id smallint)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform private.require_admin_gp(p_gp_id);
  perform private.signup_expire();
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.sup_name, 'sup_id', r.sup_code,
                     'username', r.username, 'status', r.status, 'created_at', r.created_at, 'decided_at', r.decided_at,
                     'device', r.user_agent)
                   order by (r.status = 'pending') desc, r.created_at desc)
                   from public.account_requests r
                  where r.gp_id = p_gp_id and (r.status = 'pending' or r.decided_at > now() - interval '14 days')), '[]'::jsonb);
end $$;

-- Accept: Supervisor profile + login un-banned + supervisor linked, all at once.
create or replace function public.admin_accept_account_request(p_id bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.account_requests%rowtype; v_uid uuid;
begin
  select * into r from public.account_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  v_uid := private.require_admin_gp(r.gp_id);
  if r.status <> 'pending' then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
  if r.user_id is null or not exists (select 1 from auth.users where id = r.user_id) then
    raise exception 'BAD_INPUT' using errcode = '22023', hint = 'Login পাওয়া যায়নি, request টি Reject করুন';
  end if;
  if exists (select 1 from public.profiles where username = r.username or user_id = r.user_id) then
    raise exception 'USERNAME_TAKEN' using errcode = '22023';
  end if;
  insert into public.profiles (user_id, username, full_name, role, gp_id)
  values (r.user_id, r.username, r.sup_name, 'gp_user', r.gp_id);
  update auth.users set banned_until = null, updated_at = now() where id = r.user_id;
  update public.gp_supervisors set user_id = r.user_id, updated_at = now() where id = r.supervisor_id and user_id is null;
  update public.account_requests set status = 'accepted', decided_at = now(), decided_by = v_uid where id = p_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, r.gp_id, 'account_request_accepted', 'profiles', r.user_id::text,
          jsonb_build_object('request_id', p_id, 'username', r.username, 'supervisor', r.sup_code));
  return jsonb_build_object('ok', true, 'username', r.username, 'name', r.sup_name);
end $$;

-- Reject: the (banned) login is deleted.
create or replace function public.admin_reject_account_request(p_id bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.account_requests%rowtype; v_uid uuid;
begin
  select * into r from public.account_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  v_uid := private.require_admin_gp(r.gp_id);
  if r.status <> 'pending' then raise exception 'ALREADY_DONE' using errcode = '22023'; end if;
  update public.account_requests set status = 'rejected', decided_at = now(), decided_by = v_uid where id = p_id;
  if r.user_id is not null and not exists (select 1 from public.profiles where user_id = r.user_id) then
    delete from auth.users where id = r.user_id;
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, r.gp_id, 'account_request_rejected', 'account_requests', p_id::text,
          jsonb_build_object('username', r.username, 'supervisor', r.sup_code));
  return jsonb_build_object('ok', true);
end $$;

-- How many pending (badge on the tab)
create or replace function public.admin_count_account_requests(p_gp_id smallint)
returns integer language plpgsql stable security definer set search_path to '' as $$
begin
  perform private.require_admin_gp(p_gp_id);
  return (select count(*) from public.account_requests
           where gp_id = p_gp_id and status = 'pending' and created_at > now() - interval '7 days');
end $$;

revoke all on function public.admin_get_signup_link(smallint), public.admin_set_signup_link(smallint, text, integer),
  public.admin_list_account_requests(smallint), public.admin_accept_account_request(bigint),
  public.admin_reject_account_request(bigint), public.admin_count_account_requests(smallint) from public, anon;
grant execute on function public.admin_get_signup_link(smallint), public.admin_set_signup_link(smallint, text, integer),
  public.admin_list_account_requests(smallint), public.admin_accept_account_request(bigint),
  public.admin_reject_account_request(bigint), public.admin_count_account_requests(smallint) to authenticated;

select 'Supervisor account requests ready (v213)' as result;
