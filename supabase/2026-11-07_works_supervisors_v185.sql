-- =====================================================================
-- G RAM-G 4A List Builder — Work list + Supervisor list + account in Preview (v185, 2026-11-07)
--
-- 1) gp_works: the Admin / GP Admin enters each GP's works (Work Name + Work Code)
--    once. In the phone app the supervisor searches and picks one instead of typing.
-- 2) gp_supervisors: the Admin enters the supervisors (Name + ID). In step ③ the
--    phone app shows a dropdown "Name (ID)". An ID of only digits (e.g. 1, 07)
--    becomes S-<job card prefix>-01 — the same format the app already used.
--    A blank ID gets the next free number.
-- 3) get_list_accounts (Final Preview): when the worker has no account in the
--    imported data, the Account No + IFSC a supervisor sent with the account copy
--    (📷) is shown instead (src = 'sent').
--
-- When a GP has no works / no supervisors entered, the phone app keeps the old
-- typing boxes, so nothing breaks before the Admin fills the lists.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create table if not exists public.gp_works (
  id bigint generated always as identity primary key,
  gp_id smallint not null references public.gram_panchayats(id),
  work_name text not null check (char_length(work_name) between 1 and 200),
  work_code text check (work_code is null or char_length(work_code) <= 100),
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists gp_works_name_uq on public.gp_works (gp_id, lower(work_name));
alter table public.gp_works enable row level security;
revoke all on public.gp_works from anon, authenticated;

create table if not exists public.gp_supervisors (
  id bigint generated always as identity primary key,
  gp_id smallint not null references public.gram_panchayats(id),
  name text not null check (char_length(name) between 1 and 60),
  sup_id text not null check (char_length(sup_id) between 1 and 40),
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists gp_supervisors_id_uq on public.gp_supervisors (gp_id, upper(sup_id));
alter table public.gp_supervisors enable row level security;
revoke all on public.gp_supervisors from anon, authenticated;

-- ---------- phone app ----------
create or replace function public.get_gp_masters()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return jsonb_build_object(
    'works', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.work_name, 'code', w.work_code) order by lower(w.work_name))
                       from public.gp_works w where w.gp_id = v_gp and w.active), '[]'::jsonb),
    'supervisors', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'sup_id', s.sup_id) order by lower(s.name))
                       from public.gp_supervisors s where s.gp_id = v_gp and s.active), '[]'::jsonb));
end $$;

-- ---------- Admin / GP Admin ----------
create or replace function public.admin_get_masters(p_gp_id smallint)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform private.require_admin_gp(p_gp_id);
  return jsonb_build_object(
    'works', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.work_name, 'code', w.work_code,
                         'used', (select count(*) from public.demand_lists l where l.gp_id = w.gp_id and l.deleted_at is null
                                    and lower(l.work_name) = lower(w.work_name))) order by lower(w.work_name))
                       from public.gp_works w where w.gp_id = p_gp_id and w.active), '[]'::jsonb),
    'supervisors', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'sup_id', s.sup_id) order by lower(s.name))
                       from public.gp_supervisors s where s.gp_id = p_gp_id and s.active), '[]'::jsonb),
    'jc_prefix', (select g.jc_prefix from public.gram_panchayats g where g.id = p_gp_id));
end $$;

-- p_rows = [{"name": "...", "code": "..."}]; same name (any case) = update its code
create or replace function public.admin_save_works(p_gp_id smallint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); r jsonb; v_name text; v_code text;
        v_added int := 0; v_updated int := 0; v_bad jsonb := '[]'; v_id bigint; v_old text;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_name := left(btrim(regexp_replace(coalesce(r->>'name', ''), '\s+', ' ', 'g')), 200);
    v_code := nullif(regexp_replace(coalesce(r->>'code', ''), '\s+', '', 'g'), '');
    if v_name = '' then continue; end if;
    if v_code is not null and (char_length(v_code) > 100 or v_code !~ '^[^/]+/[A-Za-z]{2,3}/[^/]+') then
      v_bad := v_bad || jsonb_build_object('name', v_name, 'code', v_code); continue;
    end if;
    select id, work_code into v_id, v_old from public.gp_works where gp_id = p_gp_id and lower(work_name) = lower(v_name);
    if v_id is null then
      insert into public.gp_works (gp_id, work_name, work_code, created_by) values (p_gp_id, v_name, v_code, v_uid);
      v_added := v_added + 1;
    else
      update public.gp_works set work_name = v_name, work_code = coalesce(v_code, work_code), active = true, updated_at = now()
       where id = v_id;
      v_updated := v_updated + 1;
    end if;
    v_id := null;
  end loop;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'works_saved', 'gp_works', p_gp_id::text, jsonb_build_object('added', v_added, 'updated', v_updated));
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'bad', v_bad);
end $$;

create or replace function public.admin_delete_work(p_id bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint;
begin
  select gp_id into v_gp from public.gp_works where id = p_id;
  if v_gp is null then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  perform private.require_admin_gp(v_gp);
  delete from public.gp_works where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- p_rows = [{"name": "...", "id": "..."}]; same ID = update the name
create or replace function public.admin_save_supervisors(p_gp_id smallint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); r jsonb; v_name text; v_sid text; v_pre text; v_n int;
        v_added int := 0; v_updated int := 0; v_bad jsonb := '[]'; v_id bigint;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select jc_prefix into v_pre from public.gram_panchayats where id = p_gp_id;
  perform pg_advisory_xact_lock(hashtextextended('sups:' || p_gp_id, 0));
  for r in select * from jsonb_array_elements(p_rows) loop
    v_name := left(btrim(regexp_replace(coalesce(r->>'name', ''), '\s+', ' ', 'g')), 60);
    v_sid := upper(regexp_replace(coalesce(r->>'id', ''), '\s+', '', 'g'));
    if v_name = '' then continue; end if;
    if v_name ~ '[()]' or v_sid ~ '[()]' or char_length(v_sid) > 40 then
      v_bad := v_bad || jsonb_build_object('name', v_name, 'id', v_sid); continue;
    end if;
    if v_sid = '' then        -- next free number
      select coalesce(max((regexp_match(sup_id, '-(\d+)$'))[1]::int), 0) + 1 into v_n
        from public.gp_supervisors where gp_id = p_gp_id and upper(sup_id) like upper('S-' || v_pre || '-%');
      v_sid := 'S-' || v_pre || '-' || lpad(v_n::text, 2, '0');
    elsif v_sid ~ '^[0-9]{1,4}$' then
      v_sid := 'S-' || v_pre || '-' || lpad(v_sid::int::text, 2, '0');
    end if;
    select id into v_id from public.gp_supervisors where gp_id = p_gp_id and upper(sup_id) = v_sid;
    if v_id is null then
      insert into public.gp_supervisors (gp_id, name, sup_id, created_by) values (p_gp_id, v_name, v_sid, v_uid);
      v_added := v_added + 1;
    else
      update public.gp_supervisors set name = v_name, active = true, updated_at = now() where id = v_id;
      v_updated := v_updated + 1;
    end if;
    v_id := null;
  end loop;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'supervisors_saved', 'gp_supervisors', p_gp_id::text, jsonb_build_object('added', v_added, 'updated', v_updated));
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'bad', v_bad);
end $$;

create or replace function public.admin_delete_supervisor(p_id bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint;
begin
  select gp_id into v_gp from public.gp_supervisors where id = p_id;
  if v_gp is null then raise exception 'NOT_FOUND' using errcode = '22023'; end if;
  perform private.require_admin_gp(v_gp);
  delete from public.gp_supervisors where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Final Preview: account from data, else the one a supervisor sent ----------
create or replace function public.get_list_accounts(p_list_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_n integer; v jsonb;
begin
  if not exists (select 1 from public.demand_lists l
                 where l.id = p_list_id and l.owner_id = auth.uid() and l.gp_id = v_gp) then
    raise exception 'LIST_NOT_FOUND' using errcode = '42501';
  end if;
  select count(*) into v_n from public.demand_list_items i where i.list_id = p_list_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_gp, 'accounts_viewed', 'demand_lists', p_list_id::text, jsonb_build_object('workers', v_n));
  select coalesce(jsonb_agg(jsonb_build_object(
           'worker_id', i.worker_id,
           'account_no', coalesce(nullif(a.account_no, ''), p.account_no),
           'ifsc', coalesce(nullif(a.ifsc, ''), p.ifsc),
           'src', case when nullif(a.account_no, '') is not null then 'data' when p.account_no is not null then 'sent' end)), '[]'::jsonb)
    into v
  from public.demand_list_items i
  join public.workers w on w.id = i.worker_id and w.gp_id = v_gp
  left join public.worker_accounts a on a.worker_id = i.worker_id
  left join lateral (select ph.account_no, ph.ifsc from public.account_photos ph
                      where ph.worker_id = i.worker_id and ph.gp_id = v_gp and ph.account_no is not null
                        and ph.status in ('new', 'done')
                      order by ph.uploaded_at desc limit 1) p on true
  where i.list_id = p_list_id;
  return v;
end $$;

revoke all on function public.get_gp_masters(), public.admin_get_masters(smallint), public.admin_save_works(smallint, jsonb),
  public.admin_delete_work(bigint), public.admin_save_supervisors(smallint, jsonb), public.admin_delete_supervisor(bigint)
  from public, anon;
grant execute on function public.get_gp_masters(), public.admin_get_masters(smallint), public.admin_save_works(smallint, jsonb),
  public.admin_delete_work(bigint), public.admin_save_supervisors(smallint, jsonb), public.admin_delete_supervisor(bigint)
  to authenticated;
