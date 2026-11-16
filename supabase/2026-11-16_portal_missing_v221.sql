-- =====================================================================
-- v221 · Workers deleted on the portal → inactive in Gram Setu (soft, undoable)
--
-- K-Desk ABPS Sync reads EVERY village's full applicant list (All workers).
-- From K-Desk v1.23.0 each sync sends a run id with its batches, and after a
-- COMPLETE sync (no village failed, not stopped) it calls kdesk_sync_finish.
-- Active workers of the synced villages that the portal no longer lists
-- (whole Job Card deleted, or one applicant deleted) become inactive:
--   active = false, inactive_reason = 'portal_missing'. Never a hard delete.
-- Inactive workers already disappear from the supervisor app (search, villages,
-- eKYC tab) and K-Desk skips them when loading a list.
--
-- Safety guards (nothing is changed when any one fails, the run is "held"
-- and the Admin decides in Admin → 🚫 Portal removed):
--   • sync not complete (a village failed / stopped)      → partial, nothing done
--   • fewer than 95% of the active workers were matched   → held
--   • more missing than max(20, 2% of active)             → held
-- A worker made inactive this way comes back by itself when a later sync finds
-- them again, and the Admin can Restore (+ "keep") anyone by hand.
--
-- Supabase dashboard → project gramg-4a-demand → SQL Editor → paste all → Run.
-- Old K-Desk versions keep working (p_run is optional).
-- =====================================================================

alter table public.workers add column if not exists inactive_reason text;
alter table public.workers add column if not exists inactive_at timestamptz;
alter table public.workers add column if not exists keep_active boolean not null default false;

create table if not exists public.kdesk_sync_runs (
  run_id       uuid primary key,
  gp_id        smallint not null references public.gram_panchayats (id),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  rows_in      integer not null default 0,
  matched      integer not null default 0,
  villages     integer[],
  status       text not null default 'running'
               check (status in ('running', 'partial', 'applied', 'nothing', 'held', 'held_applied', 'ignored')),
  scope_active integer,
  missing      integer,
  deactivated  integer,
  restored     integer not null default 0,
  missing_ids  bigint[],
  note         text,
  decided_by   uuid,
  decided_at   timestamptz
);
create index if not exists kdesk_sync_runs_gp on public.kdesk_sync_runs (gp_id, started_at desc);
alter table public.kdesk_sync_runs enable row level security;
revoke all on public.kdesk_sync_runs from anon, authenticated;

-- worker ids seen in a run (emptied when the run finishes)
create table if not exists private.kdesk_sync_seen (
  run_id    uuid not null,
  worker_id bigint not null,
  primary key (run_id, worker_id)
);

-- ---------- ABPS Sync batch (same as before + optional run id) ----------
drop function if exists public.kdesk_sync_flags(jsonb);
create or replace function public.kdesk_sync_flags(p_rows jsonb, p_run uuid default null)
 returns jsonb
 language plpgsql security definer
 set search_path to ''
 set statement_timeout to '60s'
as $function$
declare
  v_gp smallint := private.require_kdesk();
  v_prefix text; v_in integer; v_matched integer; v_changed integer; v_changes jsonb;
  v_run_gp smallint; v_run_st text; v_back integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 6000 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_run is not null then
    insert into public.kdesk_sync_runs (run_id, gp_id) values (p_run, v_gp) on conflict (run_id) do nothing;
    select gp_id, status into v_run_gp, v_run_st from public.kdesk_sync_runs where run_id = p_run;
    if v_run_gp <> v_gp or v_run_st <> 'running' then raise exception 'BAD_RUN' using errcode = '22023'; end if;
  end if;
  select jc_prefix into v_prefix from public.gram_panchayats where id = v_gp;
  v_in := jsonb_array_length(p_rows);

  create temp table if not exists kd_sync_in (card text, app integer, name text, s boolean, u boolean, b boolean, e boolean) on commit drop;
  truncate kd_sync_in;
  insert into kd_sync_in
  select private.norm_card(x->>'c'),
         case when (x->>'a') ~ '^[0-9]{1,4}$' then (x->>'a')::integer end,
         lower(btrim(regexp_replace(coalesce(x->>'n', ''), '\s+', ' ', 'g'))),
         (x->>'s') = '1', (x->>'u') = '1', (x->>'b') = '1', (x->>'e') = '1'
  from jsonb_array_elements(p_rows) x
  where left(private.norm_card(x->>'c'), 13) = v_prefix;

  create temp table if not exists kd_sync_m (worker_id bigint primary key, s boolean, u boolean, b boolean, e boolean) on commit drop;
  truncate kd_sync_m;
  -- applicant no when the report has it, otherwise the applicant name (only if it is unique in the family)
  insert into kd_sync_m
  select distinct on (w.id) w.id, i.s, i.u, i.b, i.e
  from kd_sync_in i
  join public.workers w on w.gp_id = v_gp and private.norm_card(w.job_card_no) = i.card
   and ((i.app is not null and w.applicant_no = i.app)
     or (i.app is null and i.name <> '' and lower(btrim(regexp_replace(coalesce(w.applicant_name, ''), '\s+', ' ', 'g'))) = i.name
         and (select count(*) from kd_sync_in j where j.card = i.card and j.app is null and j.name = i.name) = 1))
  order by w.id;
  get diagnostics v_matched = row_count;

  with ch as (
    update public.workers w
       set aadhaar_seeded = m.s, authentication_done = m.u, abps = m.b, ekyc = m.e, updated_at = now()
      from kd_sync_m m
     where w.id = m.worker_id
       and (w.aadhaar_seeded, w.authentication_done, w.abps, w.ekyc) is distinct from (m.s, m.u, m.b, m.e)
    returning w.id, w.job_card_no, w.applicant_no, m.b, m.e)
  select count(*), coalesce(jsonb_agg(jsonb_build_object('jc', job_card_no, 'app', applicant_no, 'abps', b, 'ekyc', e)), '[]'::jsonb)
    into v_changed, v_changes from ch;

  if p_run is not null then
    insert into private.kdesk_sync_seen (run_id, worker_id) select p_run, worker_id from kd_sync_m on conflict do nothing;
    -- back on the portal → active again (only those this feature made inactive)
    update public.workers w set active = true, inactive_reason = null, inactive_at = null, updated_at = now()
      from kd_sync_m m
     where w.id = m.worker_id and not w.active and w.inactive_reason = 'portal_missing';
    get diagnostics v_back = row_count;
    update public.kdesk_sync_runs set rows_in = rows_in + v_in, matched = matched + v_matched, restored = restored + v_back
     where run_id = p_run;
  end if;

  insert into public.audit_logs (actor_id, gp_id, action, entity, details)
  values (auth.uid(), v_gp, 'flags_synced_kdesk', 'workers',
          jsonb_build_object('rows_in', v_in, 'matched', v_matched, 'changed', v_changed, 'run', p_run, 'restored', v_back,
                             'changes', (select coalesce(jsonb_agg(c), '[]'::jsonb) from (select c from jsonb_array_elements(v_changes) c limit 2000) t)));
  return jsonb_build_object('rows_in', v_in, 'matched', v_matched, 'changed', v_changed, 'restored', v_back);
end $function$;

revoke all on function public.kdesk_sync_flags(jsonb, uuid) from public, anon;
grant execute on function public.kdesk_sync_flags(jsonb, uuid) to authenticated;

-- ---------- make a list of workers inactive (shared by finish + admin apply) ----------
create or replace function private.portal_missing_apply(p_gp smallint, p_ids bigint[])
 returns integer language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  with d as (
    update public.workers w set active = false, inactive_reason = 'portal_missing', inactive_at = now(), updated_at = now()
     where w.gp_id = p_gp and w.id = any (coalesce(p_ids, '{}')) and w.active and not w.keep_active
    returning w.id)
  select count(*) into v_n from d;
  -- Expired / Migrant marks that were waiting for the portal delete are now done
  update public.worker_marks m set status = 'deleted', updated_at = now()
   where m.gp_id = p_gp and m.worker_id = any (coalesce(p_ids, '{}')) and m.status in ('new', 'accepted', 'sent_delete');
  return v_n;
end $$;
revoke all on function private.portal_missing_apply(smallint, bigint[]) from public, anon, authenticated;

-- ---------- end of a K-Desk ABPS Sync ----------
-- p_villages = village numbers (…-013/… → 13) that came back with data
-- p_complete = every village came back, the sync was not stopped
create or replace function public.kdesk_sync_finish(p_run uuid, p_villages integer[], p_complete boolean)
 returns jsonb
 language plpgsql security definer
 set search_path to ''
 set statement_timeout to '60s'
as $function$
declare
  v_gp smallint := private.require_kdesk();
  r public.kdesk_sync_runs; v_scope integer; v_seen integer; v_ids bigint[]; v_miss integer;
  v_limit integer; v_st text; v_n integer := 0; v_note text;
begin
  select * into r from public.kdesk_sync_runs where run_id = p_run for update;
  if not found or r.gp_id <> v_gp then raise exception 'BAD_RUN' using errcode = '22023'; end if;
  if r.status <> 'running' then return jsonb_build_object('status', r.status, 'missing', r.missing, 'deactivated', r.deactivated); end if;

  if not coalesce(p_complete, false) or coalesce(cardinality(p_villages), 0) = 0 then
    v_st := 'partial'; v_note := 'Sync was not complete: nothing was made inactive.';
  else
    select count(*), count(s.worker_id) into v_scope, v_seen
      from public.workers w
      left join private.kdesk_sync_seen s on s.run_id = p_run and s.worker_id = w.id
     where w.gp_id = v_gp and w.active and w.village_no = any (p_villages);
    select coalesce(array_agg(w.id order by w.village_no, w.household_no, w.applicant_no), '{}') into v_ids
      from public.workers w
     where w.gp_id = v_gp and w.active and not w.keep_active and w.village_no = any (p_villages)
       and not exists (select 1 from private.kdesk_sync_seen s where s.run_id = p_run and s.worker_id = w.id);
    v_miss := cardinality(v_ids);
    v_limit := greatest(20, ceil(v_scope * 0.02)::integer);
    if v_miss = 0 then
      v_st := 'nothing';
    elsif v_seen < v_scope * 0.95 then
      v_st := 'held'; v_note := 'Only ' || v_seen || ' of ' || v_scope || ' active workers matched the portal list: held for the Admin.';
    elsif v_miss > v_limit then
      v_st := 'held'; v_note := v_miss || ' workers missing is more than the safe limit (' || v_limit || '): held for the Admin.';
    else
      v_n := private.portal_missing_apply(v_gp, v_ids);
      v_st := 'applied';
    end if;
  end if;

  update public.kdesk_sync_runs
     set finished_at = now(), villages = p_villages, status = v_st, scope_active = v_scope, missing = v_miss,
         deactivated = v_n, missing_ids = case when v_st = 'held' or v_n > 0 then v_ids[1:20000] end, note = v_note
   where run_id = p_run;
  delete from private.kdesk_sync_seen where run_id = p_run;
  -- leftovers of runs that never finished
  delete from private.kdesk_sync_seen s using public.kdesk_sync_runs x
   where x.run_id = s.run_id and x.status = 'running' and x.started_at < now() - interval '1 day';
  update public.kdesk_sync_runs set status = 'partial', note = 'Never finished.'
   where status = 'running' and started_at < now() - interval '1 day';

  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_gp, 'portal_missing_' || v_st, 'workers', p_run::text,
          jsonb_build_object('scope', v_scope, 'seen', v_seen, 'missing', v_miss, 'deactivated', v_n, 'villages', p_villages));
  return jsonb_build_object('status', v_st, 'scope', v_scope, 'seen', v_seen, 'missing', v_miss, 'deactivated', v_n,
                            'restored', r.restored, 'note', v_note);
end $function$;
revoke all on function public.kdesk_sync_finish(uuid, integer[], boolean) from public, anon;
grant execute on function public.kdesk_sync_finish(uuid, integer[], boolean) to authenticated;

-- ---------- Admin → 🚫 Portal removed ----------
create or replace function public.admin_portal_missing(p_gp_id smallint)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  return jsonb_build_object(
    'runs', coalesce((select jsonb_agg(jsonb_build_object(
        'run_id', x.run_id, 'started_at', x.started_at, 'finished_at', x.finished_at, 'status', x.status,
        'rows_in', x.rows_in, 'matched', x.matched, 'scope', x.scope_active, 'missing', x.missing,
        'deactivated', x.deactivated, 'restored', x.restored, 'note', x.note,
        'villages', coalesce(cardinality(x.villages), 0)) order by x.started_at desc)
      from (select * from public.kdesk_sync_runs where gp_id = p_gp_id order by started_at desc limit 15) x), '[]'::jsonb),
    -- held runs: who would go (only those still active)
    'held', coalesce((select jsonb_agg(jsonb_build_object(
        'run_id', x.run_id, 'started_at', x.started_at, 'note', x.note,
        'workers', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no,
                       'applicant_name', w.applicant_name, 'village_no', w.village_no) order by w.village_no, w.household_no, w.applicant_no), '[]'::jsonb)
                      from public.workers w where w.id = any (x.missing_ids) and w.active and not w.keep_active)) order by x.started_at desc)
      from public.kdesk_sync_runs x where x.gp_id = p_gp_id and x.status = 'held'), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no,
                       'applicant_name', w.applicant_name, 'village_no', w.village_no, 'inactive_at', w.inactive_at)
                       order by w.inactive_at desc, w.village_no, w.household_no, w.applicant_no)
      from public.workers w where w.gp_id = p_gp_id and not w.active and w.inactive_reason = 'portal_missing'), '[]'::jsonb),
    'kept', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no,
                       'applicant_name', w.applicant_name, 'village_no', w.village_no) order by w.village_no, w.household_no, w.applicant_no)
      from public.workers w where w.gp_id = p_gp_id and w.keep_active), '[]'::jsonb));
end $$;
revoke all on function public.admin_portal_missing(smallint) from public, anon;
grant execute on function public.admin_portal_missing(smallint) to authenticated;

-- p_action: 'apply' (make the held list inactive; p_ids = only these, null = all) | 'ignore'
create or replace function public.admin_portal_missing_decide(p_run uuid, p_action text, p_ids bigint[] default null)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare r public.kdesk_sync_runs; v_uid uuid; v_n integer := 0; v_ids bigint[];
begin
  select * into r from public.kdesk_sync_runs where run_id = p_run for update;
  if not found then raise exception 'BAD_RUN' using errcode = '22023'; end if;
  v_uid := private.require_admin_gp(r.gp_id);
  if r.status <> 'held' then raise exception 'NOT_HELD' using errcode = '22023'; end if;
  if p_action = 'apply' then
    select coalesce(array_agg(i), '{}') into v_ids from unnest(r.missing_ids) i where p_ids is null or i = any (p_ids);
    v_n := private.portal_missing_apply(r.gp_id, v_ids);
    update public.kdesk_sync_runs set status = 'held_applied', deactivated = v_n, decided_by = v_uid, decided_at = now() where run_id = p_run;
  elsif p_action = 'ignore' then
    update public.kdesk_sync_runs set status = 'ignored', missing_ids = null, decided_by = v_uid, decided_at = now() where run_id = p_run;
  else
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, r.gp_id, 'portal_missing_' || p_action, 'workers', p_run::text, jsonb_build_object('deactivated', v_n));
  return jsonb_build_object('deactivated', v_n);
end $$;
revoke all on function public.admin_portal_missing_decide(uuid, text, bigint[]) from public, anon;
grant execute on function public.admin_portal_missing_decide(uuid, text, bigint[]) to authenticated;

-- Restore by hand. p_keep = true: later syncs never make them inactive again (keep_active).
-- p_keep = false on an active worker just lifts "keep".
create or replace function public.admin_portal_restore(p_gp_id smallint, p_ids bigint[], p_keep boolean default true)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_n integer;
begin
  update public.workers w
     set active = case when w.inactive_reason = 'portal_missing' then true else w.active end,
         inactive_reason = case when w.inactive_reason = 'portal_missing' then null else w.inactive_reason end,
         inactive_at = case when w.inactive_reason = 'portal_missing' then null else w.inactive_at end,
         keep_active = coalesce(p_keep, true), updated_at = now()
   where w.gp_id = p_gp_id and w.id = any (coalesce(p_ids, '{}'));
  get diagnostics v_n = row_count;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'portal_missing_restore', 'workers', array_to_string(p_ids, ','), jsonb_build_object('n', v_n, 'keep', p_keep));
  return jsonb_build_object('changed', v_n);
end $$;
revoke all on function public.admin_portal_restore(smallint, bigint[], boolean) from public, anon;
grant execute on function public.admin_portal_restore(smallint, bigint[], boolean) to authenticated;

notify pgrst, 'reload schema';
