-- =====================================================================
-- G RAM-G 4A List Builder — admin upgrade (2026-10-25)
--   1) Work Code per list (admin sets it, K-Desk fills it in)
--   2) K-Desk status per list + K-Desk activity (last ABPS Sync etc.)
--   3) Demand / Allocation results written back from K-Desk
--   4) Delete user (admin)
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

-- ---------- 1) Work Code per list ----------
alter table public.demand_lists add column if not exists work_code text;
do $$ begin
  alter table public.demand_lists add constraint demand_lists_work_code_len check (work_code is null or char_length(work_code) <= 100);
exception when duplicate_object then null; end $$;

create or replace function public.admin_set_list_work_code(p_list_id uuid, p_work_code text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_uid uuid := private.require_super_admin(); v_list public.demand_lists%rowtype;
        v_code text := nullif(regexp_replace(coalesce(p_work_code, ''), '\s+', '', 'g'), '');
begin
  select * into v_list from public.demand_lists where id = p_list_id and status = 'active' for update;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = '42501'; end if;
  if v_code is not null and (char_length(v_code) > 100 or v_code !~ '^[^/]+/[A-Za-z]{2,3}/[^/]+') then
    raise exception 'BAD_WORK_CODE' using errcode = '22023';
  end if;
  update public.demand_lists set work_code = v_code, updated_at = now() where id = p_list_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_list.gp_id, 'list_work_code_by_admin', 'demand_lists', p_list_id::text,
          jsonb_build_object('from', v_list.work_code, 'to', v_code));
  return jsonb_build_object('work_code', v_code);
end $function$;

-- ---------- 3) results table (only reachable through the functions below) ----------
create table if not exists public.list_item_results (
  list_id      uuid   not null references public.demand_lists(id) on delete cascade,
  worker_id    bigint not null references public.workers(id) on delete cascade,
  demand_status text check (demand_status in ('done', 'error', 'skipped')),
  demand_msg   text,
  demand_at    timestamptz,
  work_code    text,
  alloc_status text check (alloc_status in ('done', 'error', 'skipped')),
  alloc_msg    text,
  alloc_at     timestamptz,
  updated_by   uuid,
  primary key (list_id, worker_id)
);
alter table public.list_item_results enable row level security;
revoke all on public.list_item_results from anon, authenticated;

-- K-Desk sends one row per worker: {l: list_id, w: worker_id, k: 'demand'|'alloc', s: status, m: message, c: work code}
create or replace function public.kdesk_report_results(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' set statement_timeout to '60s' as $function$
declare v_gp smallint := private.require_kdesk(); v_in integer; v_d integer := 0; v_a integer := 0; v_lists jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 3000 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  v_in := jsonb_array_length(p_rows);
  create temp table if not exists kd_res_in (list_id uuid, worker_id bigint, kind text, st text, msg text, code text) on commit drop;
  truncate kd_res_in;
  insert into kd_res_in
  select distinct on ((x->>'l'), (x->>'w'), (x->>'k'))
         (x->>'l')::uuid, (x->>'w')::bigint, x->>'k', x->>'s', left(coalesce(x->>'m', ''), 300), left(nullif(x->>'c', ''), 100)
  from jsonb_array_elements(p_rows) x
  where (x->>'l') ~ '^[0-9a-f-]{36}$' and (x->>'w') ~ '^[0-9]{1,18}$'
    and (x->>'k') in ('demand', 'alloc') and (x->>'s') in ('done', 'error', 'skipped');
  -- only this GP's active lists, only workers that are in that list
  delete from kd_res_in r where not exists (
    select 1 from public.demand_lists l join public.demand_list_items i on i.list_id = l.id
     where l.id = r.list_id and l.gp_id = v_gp and l.status = 'active' and i.worker_id = r.worker_id);

  insert into public.list_item_results as t (list_id, worker_id, demand_status, demand_msg, demand_at, updated_by)
  select list_id, worker_id, st, msg, now(), auth.uid() from kd_res_in where kind = 'demand'
  on conflict (list_id, worker_id) do update
    set demand_status = excluded.demand_status, demand_msg = excluded.demand_msg, demand_at = excluded.demand_at,
        -- a new Demand run starts a new round: the old Allocation result no longer applies
        alloc_status = null, alloc_msg = null, alloc_at = null, updated_by = excluded.updated_by;
  get diagnostics v_d = row_count;

  insert into public.list_item_results as t (list_id, worker_id, work_code, alloc_status, alloc_msg, alloc_at, updated_by)
  select list_id, worker_id, code, st, msg, now(), auth.uid() from kd_res_in where kind = 'alloc'
  on conflict (list_id, worker_id) do update
    set work_code = coalesce(excluded.work_code, t.work_code), alloc_status = excluded.alloc_status,
        alloc_msg = excluded.alloc_msg, alloc_at = excluded.alloc_at, updated_by = excluded.updated_by;
  get diagnostics v_a = row_count;

  select coalesce(jsonb_agg(distinct list_id), '[]'::jsonb) into v_lists from kd_res_in;
  insert into public.audit_logs (actor_id, gp_id, action, entity, details)
  values (auth.uid(), v_gp, 'results_reported_kdesk', 'list_item_results',
          jsonb_build_object('rows_in', v_in, 'demand', v_d, 'alloc', v_a, 'lists', v_lists,
            'demand_ok', (select count(*) from kd_res_in where kind = 'demand' and st = 'done'),
            'alloc_ok', (select count(*) from kd_res_in where kind = 'alloc' and st = 'done')));
  return jsonb_build_object('rows_in', v_in, 'demand', v_d, 'alloc', v_a);
end $function$;

-- Supervisor: results of one of their own lists
create or replace function public.get_list_results(p_list_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_gp smallint := private.require_gp_user(); v jsonb;
begin
  if not exists (select 1 from public.demand_lists where id = p_list_id and owner_id = auth.uid() and gp_id = v_gp and status = 'active') then
    raise exception 'LIST_NOT_FOUND' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
           'demand_status', r.demand_status, 'demand_msg', r.demand_msg, 'demand_at', r.demand_at,
           'work_code', r.work_code, 'alloc_status', r.alloc_status, 'alloc_msg', r.alloc_msg, 'alloc_at', r.alloc_at)
         order by w.village_no, w.household_no, w.job_card_no, w.applicant_no), '[]'::jsonb)
    into v
  from public.demand_list_items i
  join public.workers w on w.id = i.worker_id
  left join public.list_item_results r on r.list_id = i.list_id and r.worker_id = i.worker_id
  where i.list_id = p_list_id;
  return v;
end $function$;

-- ---------- K-Desk sees each list's Work Code ----------
create or replace function public.kdesk_lists()
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_gp smallint := private.require_kdesk(); v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'list_id', l.id, 'username', p.username, 'full_name', p.full_name, 'work_name', l.work_name,
           'work_code', l.work_code,
           'supervisors', to_jsonb(l.supervisors), 'submit_state', l.submit_state,
           'submitted_at', l.submitted_at, 'locked_at', l.locked_at,
           'exported_at', l.exported_at, 'export_count', l.export_count,
           'workers', (select count(*) from public.demand_list_items i where i.list_id = l.id),
           'eligible', (select count(*) from public.demand_list_items i join public.workers w on w.id = i.worker_id
                         where i.list_id = l.id and w.eligible and w.active))
         order by l.submitted_at desc nulls last, l.work_name), '[]'::jsonb)
    into v
  from public.demand_lists l join public.profiles p on p.user_id = l.owner_id
  where l.gp_id = v_gp and l.status = 'active' and l.submit_state in ('submitted', 'locked');
  return v;
end $function$;

create or replace function public.kdesk_list_rows(p_list_ids uuid[])
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_gp smallint := private.require_kdesk(); v_n integer; v jsonb;
begin
  if coalesce(cardinality(p_list_ids), 0) = 0 or cardinality(p_list_ids) > 200 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  select count(*) into v_n from public.demand_lists l
   where l.id = any(p_list_ids) and l.gp_id = v_gp and l.status = 'active' and l.submit_state in ('submitted', 'locked');
  if v_n <> (select count(distinct x) from unnest(p_list_ids) x) then
    raise exception 'LIST_NOT_FOUND' using errcode = '42501';
  end if;
  update public.demand_lists l set exported_at = now(), export_count = l.export_count + 1
   where l.id = any(p_list_ids);
  insert into public.audit_logs (actor_id, gp_id, action, entity, details)
  values (auth.uid(), v_gp, 'lists_loaded_kdesk', 'demand_lists', jsonb_build_object('lists', to_jsonb(p_list_ids)));
  select coalesce(jsonb_agg(jsonb_build_object(
           'list_id', l.id, 'username', p.username, 'work_name', l.work_name, 'work_code', l.work_code, 'worker_id', w.id,
           'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
           'village_no', w.village_no, 'household_no', w.household_no, 'eligible', w.eligible,
           'ekyc', w.ekyc, 'abps', w.abps, 'worker_active', w.active)
         order by w.village_no, w.household_no, w.job_card_no, w.applicant_no, p.username), '[]'::jsonb)
    into v
  from public.demand_lists l
  join public.profiles p on p.user_id = l.owner_id
  join public.demand_list_items i on i.list_id = l.id
  join public.workers w on w.id = i.worker_id
  where l.id = any(p_list_ids);
  return v;
end $function$;

-- ---------- 2) admin dashboard: Work Code, K-Desk load and results per list ----------
create or replace function public.admin_dashboard(p_gp_id smallint)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_uid uuid := private.require_super_admin(); v jsonb;
begin
  select coalesce(jsonb_agg(u order by u->>'username'), '[]'::jsonb) into v from (
    select jsonb_build_object(
      'user_id', p.user_id, 'username', p.username, 'full_name', p.full_name, 'active', p.active,
      'active_devices', (select count(*) from public.device_sessions d where d.user_id = p.user_id and d.revoked_at is null),
      'last_seen', (select max(d.last_seen_at) from public.device_sessions d where d.user_id = p.user_id),
      'lists', coalesce((
        select jsonb_agg(jsonb_build_object(
          'list_id', l.id, 'work_name', l.work_name, 'work_code', l.work_code, 'supervisors', to_jsonb(l.supervisors),
          'submit_state', l.submit_state, 'workers', c.n,
          'required_supervisors', private.required_supervisors(c.n::int),
          'villages', (select coalesce(to_jsonb(array_agg(distinct w.village_no order by w.village_no)), '[]'::jsonb)
                         from public.demand_list_items i join public.workers w on w.id = i.worker_id where i.list_id = l.id),
          'list_updated_at', l.updated_at, 'submitted_at', l.submitted_at, 'locked_at', l.locked_at,
          'exported_at', l.exported_at, 'export_count', l.export_count,
          'kdesk_loaded_at', (select max(a.at) from public.audit_logs a
                               where a.action = 'lists_loaded_kdesk' and a.gp_id = l.gp_id and a.details->'lists' ? l.id::text),
          'results', (select jsonb_build_object(
                         'demand_ok', count(*) filter (where r.demand_status = 'done'),
                         'demand_err', count(*) filter (where r.demand_status in ('error', 'skipped')),
                         'alloc_ok', count(*) filter (where r.alloc_status = 'done'),
                         'alloc_err', count(*) filter (where r.alloc_status in ('error', 'skipped')),
                         'at', greatest(max(r.demand_at), max(r.alloc_at)))
                       from public.list_item_results r
                       join public.demand_list_items i on i.list_id = r.list_id and i.worker_id = r.worker_id
                      where r.list_id = l.id),
          'submissions', (select count(*) from public.list_submissions s where s.list_id = l.id))
          order by l.created_at)
        from public.demand_lists l
        cross join lateral (select count(*) as n from public.demand_list_items i where i.list_id = l.id) c
        where l.owner_id = p.user_id and l.gp_id = p_gp_id and l.status = 'active'), '[]'::jsonb)) as u
    from public.profiles p
    where p.role = 'gp_user' and p.gp_id = p_gp_id) t;
  return v;
end $function$;

-- list preview: Work Code and each worker's Demand / Allocation result
create or replace function public.admin_list_items(p_list_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_uid uuid := private.require_super_admin(); v_list public.demand_lists%rowtype; v jsonb;
begin
  select * into v_list from public.demand_lists where id = p_list_id;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = '42501'; end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id)
  values (v_uid, v_list.gp_id, 'list_previewed_by_admin', 'demand_lists', p_list_id::text);
  select jsonb_build_object(
    'list_id', v_list.id, 'gp_id', v_list.gp_id, 'work_name', v_list.work_name, 'work_code', v_list.work_code,
    'status', v_list.status, 'supervisors', to_jsonb(v_list.supervisors), 'version', v_list.version,
    'submit_state', v_list.submit_state, 'submitted_at', v_list.submitted_at,
    'exported_at', v_list.exported_at, 'export_count', v_list.export_count,
    'submissions', (select count(*) from public.list_submissions s where s.list_id = v_list.id),
    'username', (select username from public.profiles where user_id = v_list.owner_id),
    'full_name', (select full_name from public.profiles where user_id = v_list.owner_id),
    'required_supervisors', private.required_supervisors(count(w.id)::int),
    'items', coalesce(jsonb_agg(jsonb_build_object(
        'worker_id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no,
        'applicant_name', w.applicant_name, 'village_no', w.village_no, 'household_no', w.household_no,
        'ekyc', w.ekyc, 'abps', w.abps, 'eligible', w.eligible, 'active', w.active,
        'account_no', a.account_no, 'ifsc', a.ifsc,
        'demand_status', r.demand_status, 'demand_msg', r.demand_msg, 'demand_at', r.demand_at,
        'alloc_status', r.alloc_status, 'alloc_msg', r.alloc_msg, 'alloc_at', r.alloc_at, 'res_work_code', r.work_code,
        'in_other_lists', (select count(*) from public.demand_list_items i2
                             join public.demand_lists l2 on l2.id = i2.list_id
                            where i2.worker_id = w.id and l2.id <> v_list.id
                              and l2.status = 'active' and l2.gp_id = v_list.gp_id))
      order by w.village_no, w.household_no, w.job_card_no, w.applicant_no)
      filter (where w.id is not null), '[]'::jsonb))
    into v
  from public.demand_list_items i
  join public.workers w on w.id = i.worker_id
  left join public.worker_accounts a on a.worker_id = w.id
  left join public.list_item_results r on r.list_id = i.list_id and r.worker_id = i.worker_id
  where i.list_id = p_list_id;
  return v;
end $function$;

-- K-Desk activity for one GP: last list loads, locks, ABPS Syncs and result uploads
create or replace function public.admin_kdesk_activity(p_gp_id smallint, p_limit integer default 15)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_uid uuid := private.require_super_admin(); v jsonb;
begin
  select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) into v from (
    select jsonb_build_object('at', a.at, 'action', a.action, 'username', p.username,
             'details', a.details - 'changes',
             'lists', (select coalesce(jsonb_agg(coalesce(l.work_name, '?')), '[]'::jsonb)
                         from jsonb_array_elements_text(case when jsonb_typeof(a.details->'lists') = 'array' then a.details->'lists' else '[]'::jsonb end) li
                         left join public.demand_lists l on l.id::text = li)) x
    from public.audit_logs a left join public.profiles p on p.user_id = a.actor_id
    where a.gp_id = p_gp_id
      and a.action in ('lists_loaded_kdesk', 'lists_locked_kdesk', 'flags_synced_kdesk', 'results_reported_kdesk')
    order by a.at desc
    limit least(greatest(coalesce(p_limit, 15), 1), 100)) t;
  return jsonb_build_object('events', v,
    'last_sync', (select jsonb_build_object('at', a.at, 'rows_in', a.details->'rows_in', 'matched', a.details->'matched', 'changed', a.details->'changed')
                    from public.audit_logs a where a.gp_id = p_gp_id and a.action = 'flags_synced_kdesk' order by a.at desc limit 1));
end $function$;

-- ---------- 4) delete a user (Supervisor / K-Desk login; never a Super Admin, never yourself) ----------
create or replace function public.admin_delete_user(p_user_id uuid, p_confirm_username text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_uid uuid := private.require_super_admin(); v_p public.profiles%rowtype; v_lists integer;
begin
  if p_user_id is null or p_user_id = v_uid then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select * into v_p from public.profiles where user_id = p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND' using errcode = '22023'; end if;
  if v_p.role = 'super_admin' then raise exception 'CANNOT_DELETE_ADMIN' using errcode = '42501'; end if;
  if lower(btrim(coalesce(p_confirm_username, ''))) <> v_p.username then raise exception 'CONFIRM_MISMATCH' using errcode = '22023'; end if;
  if exists (select 1 from public.import_jobs where created_by = p_user_id) then
    raise exception 'USER_HAS_IMPORTS' using errcode = '22023';
  end if;
  select count(*) into v_lists from public.demand_lists where owner_id = p_user_id;
  -- keep other people's lists intact: only clear the "who did it" pointers
  update public.demand_list_items set added_by = null where added_by = p_user_id;
  update public.demand_lists set locked_by = null where locked_by = p_user_id;
  update public.import_jobs set committed_by = null where committed_by = p_user_id;
  update public.list_item_results set updated_by = null where updated_by = p_user_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_p.gp_id, 'user_deleted', 'profiles', p_user_id::text,
          jsonb_build_object('username', v_p.username, 'full_name', v_p.full_name, 'role', v_p.role, 'lists_deleted', v_lists));
  -- profile, device sessions, the user's own lists (with items, copies and results) go with the account
  delete from auth.users where id = p_user_id;
  return jsonb_build_object('username', v_p.username, 'lists_deleted', v_lists);
end $function$;

-- ---------- permissions ----------
revoke all on function public.admin_set_list_work_code(uuid, text) from public, anon;
revoke all on function public.kdesk_report_results(jsonb) from public, anon;
revoke all on function public.get_list_results(uuid) from public, anon;
revoke all on function public.admin_kdesk_activity(smallint, integer) from public, anon;
revoke all on function public.admin_delete_user(uuid, text) from public, anon;
grant execute on function public.admin_set_list_work_code(uuid, text) to authenticated;
grant execute on function public.kdesk_report_results(jsonb) to authenticated;
grant execute on function public.get_list_results(uuid) to authenticated;
grant execute on function public.admin_kdesk_activity(smallint, integer) to authenticated;
grant execute on function public.admin_delete_user(uuid, text) to authenticated;

select 'OK: List Builder admin upgrade installed' as result;
