-- =====================================================================
-- G RAM-G 4A — IAY Tracker live sync (v192, 2026-11-09)
--
-- The IAY Phase Report Tampermonkey script sends each GP straight to the
-- tracker after every portal Update, without a List Builder login
-- (a login there would use one of the two allowed devices).
--
--   iay_sync_key_create()  admin makes a key (shown once; old key stops working)
--   iay_sync_key_status()  is a key active, when was it last used
--   iay_sync_key_revoke()  stop the key
--   iay_sync_gp(p_key, …)  called by the script (anon). Same rules as upload:
--                          Super Admin key = any GP, GP Admin key = own GP only.
-- Only the SHA-256 of the key is stored. Requires v191.
-- Safe to run again.
-- =====================================================================

create table if not exists public.iay_sync_keys (
  id           bigint generated always as identity primary key,
  key_hash     text not null unique,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  last_gp      text,
  revoked_at   timestamptz
);
create index if not exists iay_sync_keys_user_idx on public.iay_sync_keys (user_id) where revoked_at is null;
alter table public.iay_sync_keys enable row level security;
revoke all on public.iay_sync_keys from anon, authenticated;

-- A Job Card prefix (WB-08-005-014) and its work-code prefix (3208005014) must agree,
-- or the Job Card itself must carry the prefix.
create or replace function private.iay_row_in_gp(p_prefix text, p_code text, p_jcn text)
returns boolean language sql immutable set search_path to '' as $$
  select left(coalesce(p_jcn, ''), 13) = p_prefix
      or substr(coalesce(p_code, ''), 3, 8) = replace(substr(p_prefix, 4), '-', '')
$$;

-- Shared import used by the Excel upload and by the script.
create or replace function private.iay_import_core(p_jc_prefix text, p_gp_name text, p_report_at timestamptz,
                                                  p_file_name text, p_works jsonb, p_mrs jsonb, p_force boolean, p_actor uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_last timestamptz; v_bad int; v_w int; v_m int;
begin
  if p_jc_prefix is null or p_jc_prefix !~ '^WB-[0-9]{2}-[0-9]{3}-[0-9]{3}$' then raise exception 'BAD_GP'; end if;
  if jsonb_typeof(p_works) <> 'array' or jsonb_array_length(p_works) = 0 then raise exception 'NO_WORKS'; end if;
  if jsonb_array_length(p_works) > 20000 or jsonb_array_length(coalesce(p_mrs, '[]'::jsonb)) > 60000 then raise exception 'TOO_MANY_ROWS'; end if;

  select count(*) into v_bad from jsonb_array_elements(p_works) x
   where coalesce(x->>'work_code', '') = '' or not private.iay_row_in_gp(p_jc_prefix, x->>'work_code', x->>'jcn');
  if v_bad > 0 then raise exception 'WRONG_GP_ROWS' using detail = v_bad || ' rows'; end if;

  select max(report_at) into v_last from public.iay_imports where jc_prefix = p_jc_prefix;
  if not coalesce(p_force, false) and v_last is not null and p_report_at is not null and p_report_at < v_last then
    raise exception 'OLDER_REPORT';
  end if;

  delete from public.iay_works where jc_prefix = p_jc_prefix;

  insert into public.iay_works (work_code, jc_prefix, gp_name, reg_no, ben_name, jcn, village, work_status,
                                mandays, wl_info, wl_no, wl_date, report_at)
  select distinct on (x->>'work_code')
         left(x->>'work_code', 60), p_jc_prefix, left(p_gp_name, 100), left(nullif(x->>'reg_no', ''), 60),
         left(nullif(x->>'ben_name', ''), 300), left(x->>'jcn', 60), left(nullif(x->>'village', ''), 150),
         left(nullif(x->>'work_status', ''), 40),
         case when x->>'mandays' ~ '^[0-9]{1,4}$' then (x->>'mandays')::int end,
         left(nullif(x->>'wl_info', ''), 40), left(nullif(x->>'wl_no', ''), 500),
         case when x->>'wl_date' ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'wl_date')::date end,
         p_report_at
    from jsonb_array_elements(p_works) x
   where char_length(x->>'work_code') >= 5
   order by x->>'work_code';
  get diagnostics v_w = row_count;

  insert into public.iay_mrs (work_code, mr_no, seq, start_date, end_date, status)
  select distinct on (x->>'work_code', (x->>'mr_no')::bigint)
         x->>'work_code', (x->>'mr_no')::bigint,
         case when x->>'seq' ~ '^[0-9]{1,3}$' then (x->>'seq')::smallint end,
         (x->>'start_date')::date, (x->>'end_date')::date, left(nullif(x->>'status', ''), 30)
    from jsonb_array_elements(coalesce(p_mrs, '[]'::jsonb)) x
    join public.iay_works w on w.work_code = x->>'work_code'
   where x->>'mr_no' ~ '^[0-9]{1,15}$'
     and x->>'start_date' ~ '^\d{4}-\d{2}-\d{2}$' and x->>'end_date' ~ '^\d{4}-\d{2}-\d{2}$'
   order by x->>'work_code', (x->>'mr_no')::bigint;
  get diagnostics v_m = row_count;

  insert into public.iay_imports (jc_prefix, gp_name, works, mrs, report_at, file_name, imported_by)
  values (p_jc_prefix, left(p_gp_name, 100), v_w, v_m, p_report_at, left(p_file_name, 200), p_actor);

  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (p_actor, (select id from public.gram_panchayats where jc_prefix = p_jc_prefix), 'iay_import', 'iay', p_jc_prefix,
          jsonb_build_object('gp', p_gp_name, 'works', v_w, 'mrs', v_m, 'report_at', p_report_at, 'source', left(p_file_name, 60)));

  return jsonb_build_object('works', v_w, 'mrs', v_m);
end $$;
revoke all on function private.iay_row_in_gp(text, text, text),
                       private.iay_import_core(text, text, timestamptz, text, jsonb, jsonb, boolean, uuid) from public, anon;

-- Excel upload (logged-in admin) now uses the shared import.
create or replace function public.iay_import_gp(p_jc_prefix text, p_gp_name text, p_report_at timestamptz,
                                               p_file_name text, p_works jsonb, p_mrs jsonb, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope();
begin
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return private.iay_import_core(p_jc_prefix, p_gp_name, p_report_at, p_file_name, p_works, p_mrs, p_force, auth.uid());
end $$;

-- ---------------------------------------------------------------------
create or replace function public.iay_sync_key_create()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); v_key text; v_uid uuid := auth.uid();
begin
  update public.iay_sync_keys set revoked_at = now() where user_id = v_uid and revoked_at is null;
  v_key := 'iay_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.iay_sync_keys (key_hash, user_id) values (encode(extensions.digest(v_key, 'sha256'), 'hex'), v_uid);
  insert into public.audit_logs (actor_id, action, entity, details) values (v_uid, 'iay_sync_key_create', 'iay', jsonb_build_object('scope', v_scope));
  return jsonb_build_object('key', v_key, 'scope', v_scope);
end $$;

create or replace function public.iay_sync_key_status()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); r public.iay_sync_keys%rowtype;
begin
  select * into r from public.iay_sync_keys where user_id = auth.uid() and revoked_at is null order by created_at desc limit 1;
  if not found then return jsonb_build_object('active', false); end if;
  return jsonb_build_object('active', true, 'created_at', r.created_at, 'last_used_at', r.last_used_at, 'last_gp', r.last_gp, 'scope', v_scope);
end $$;

create or replace function public.iay_sync_key_revoke()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); n int;
begin
  update public.iay_sync_keys set revoked_at = now() where user_id = auth.uid() and revoked_at is null;
  get diagnostics n = row_count;
  insert into public.audit_logs (actor_id, action, entity, details) values (auth.uid(), 'iay_sync_key_revoke', 'iay', jsonb_build_object('n', n));
  return jsonb_build_object('revoked', n);
end $$;

-- Called by the Tampermonkey script (no login). The key decides who it is.
create or replace function public.iay_sync_gp(p_key text, p_jc_prefix text, p_gp_name text,
                                             p_works jsonb, p_mrs jsonb, p_source text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare k public.iay_sync_keys%rowtype; p public.profiles%rowtype; v_scope text; v_out jsonb;
begin
  if p_key is null or p_key !~ '^iay_[0-9a-f]{48}$' then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  select * into k from public.iay_sync_keys
   where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex') and revoked_at is null;
  if not found then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  select * into p from public.profiles where user_id = k.user_id and active;
  if not found or p.role not in ('super_admin', 'gp_admin') then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  if p.role = 'gp_admin' then
    select g.jc_prefix into v_scope from public.gram_panchayats g where g.id = p.gp_id and g.active;
    if v_scope is null or v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  end if;
  v_out := private.iay_import_core(p_jc_prefix, p_gp_name, now(), coalesce(left(p_source, 60), 'Tampermonkey live'),
                                   p_works, p_mrs, false, k.user_id);
  update public.iay_sync_keys set last_used_at = now(), last_gp = left(p_gp_name, 100) where id = k.id;
  return v_out;
end $$;

revoke all on function public.iay_sync_key_create(), public.iay_sync_key_status(), public.iay_sync_key_revoke(),
                       public.iay_sync_gp(text, text, text, jsonb, jsonb, text) from public;
grant execute on function public.iay_sync_key_create(), public.iay_sync_key_status(), public.iay_sync_key_revoke() to authenticated;
grant execute on function public.iay_sync_gp(text, text, text, jsonb, jsonb, text) to anon, authenticated;

select 'OK: IAY live sync installed' as result;
