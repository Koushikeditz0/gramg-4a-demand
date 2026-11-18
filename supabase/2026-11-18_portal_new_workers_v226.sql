-- =====================================================================
-- v226 · New Job Cards / applicants found by ABPS Sync → Admin accepts them
--
-- Until now K-Desk ABPS Sync only updated the 4 flags of workers that were
-- already in Gram Setu. A Job Card or applicant added on the portal after the
-- Excel import never reached the supervisor app.
--
-- Now every ABPS Sync batch also keeps the portal rows that match nobody in
-- Gram Setu (with Job Card + Applicant No + name) in public.portal_new_workers.
-- Admin → 🚫 Portal sync → "🆕 New on the portal" lists them; the Admin ticks
-- and presses Accept → they become normal active workers (with the 4 flags
-- from the portal). Ignore hides a row; later syncs do not bring it back.
-- Nothing is added by itself.
--
-- Bank account / IFSC / caste are not in the ABPS report: they come later
-- from 🏦 Account Sync / the caste register, as for everyone else.
--
-- A row disappears from the list by itself when that worker reaches Gram Setu
-- another way (Excel import).
--
-- No K-Desk update needed: it uses the rows K-Desk already sends.
-- Supabase dashboard → project gramg-4a-demand → SQL Editor → paste all → Run.
-- =====================================================================

begin;

create table if not exists public.portal_new_workers (
  id             bigint generated always as identity primary key,
  gp_id          smallint not null references public.gram_panchayats (id),
  job_card_no    text not null,
  applicant_no   integer not null,
  applicant_name text not null,
  aadhaar_seeded boolean not null default false,
  authentication_done boolean not null default false,
  abps           boolean not null default false,
  ekyc           boolean not null default false,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  status         text not null default 'new' check (status in ('new', 'accepted', 'ignored')),
  worker_id      bigint,
  decided_by     uuid,
  decided_at     timestamptz,
  unique (gp_id, job_card_no, applicant_no)
);
create index if not exists portal_new_workers_gp_status on public.portal_new_workers (gp_id, status);
alter table public.portal_new_workers enable row level security;
revoke all on public.portal_new_workers from anon, authenticated;

-- ---------- ABPS Sync batch: v222 + keep the rows nobody matched ----------
create or replace function public.kdesk_sync_flags(p_rows jsonb, p_run uuid default null)
 returns jsonb
 language plpgsql security definer
 set search_path to ''
 set statement_timeout to '60s'
as $function$
declare
  v_gp smallint := private.require_kdesk();
  v_prefix text; v_in integer; v_matched integer; v_changed integer; v_changes jsonb;
  v_run_gp smallint; v_run_st text; v_back integer := 0; v_new integer := 0;
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

  -- (new temp table name: the v222 one had no raw-name column)
  create temp table if not exists kd_sync_in2 (card text, app integer, name text, raw_name text, s boolean, u boolean, b boolean, e boolean, matched boolean) on commit drop;
  truncate kd_sync_in2;
  insert into kd_sync_in2
  select private.norm_card(x->>'c'),
         case when (x->>'a') ~ '^[0-9]{1,4}$' then (x->>'a')::integer end,
         lower(btrim(regexp_replace(coalesce(x->>'n', ''), '\s+', ' ', 'g'))),
         btrim(regexp_replace(coalesce(x->>'n', ''), '\s+', ' ', 'g')),
         (x->>'s') = '1', (x->>'u') = '1', (x->>'b') = '1', (x->>'e') = '1', false
  from jsonb_array_elements(p_rows) x
  where left(private.norm_card(x->>'c'), 13) = v_prefix;
  analyze kd_sync_in2;  -- fresh statistics so the joins below use a hash join (seconds → milliseconds)

  create temp table if not exists kd_sync_m (worker_id bigint primary key, s boolean, u boolean, b boolean, e boolean) on commit drop;
  truncate kd_sync_m;
  -- applicant no when the report has it, otherwise the applicant name (only if it is unique in the family)
  insert into kd_sync_m
  select distinct on (w.id) w.id, i.s, i.u, i.b, i.e
  from kd_sync_in2 i
  join public.workers w on w.gp_id = v_gp and private.norm_card(w.job_card_no) = i.card
   and ((i.app is not null and w.applicant_no = i.app)
     or (i.app is null and i.name <> '' and lower(btrim(regexp_replace(coalesce(w.applicant_name, ''), '\s+', ' ', 'g'))) = i.name
         and (select count(*) from kd_sync_in2 j where j.card = i.card and j.app is null and j.name = i.name) = 1))
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

  -- v226: portal rows that are not in Gram Setu at all (any worker, active or not, with that Job Card + Applicant No)
  with nw as (
    insert into public.portal_new_workers as t (gp_id, job_card_no, applicant_no, applicant_name, aadhaar_seeded, authentication_done, abps, ekyc)
    select distinct on (i.card, i.app) v_gp, i.card, i.app, left(i.raw_name, 150), i.s, i.u, i.b, i.e
      from kd_sync_in2 i
     where i.app between 1 and 9999 and i.raw_name <> ''
       and i.card ~ '^WB-[0-9]{2}-[0-9]{3}-[0-9]{3}-[0-9]{3}/[0-9]+(-[A-Z])?$'
       and not exists (select 1 from public.workers w
                        where w.gp_id = v_gp and w.applicant_no = i.app and private.norm_card(w.job_card_no) = i.card)
     order by i.card, i.app
    on conflict (gp_id, job_card_no, applicant_no) do update
       set applicant_name = excluded.applicant_name, aadhaar_seeded = excluded.aadhaar_seeded,
           authentication_done = excluded.authentication_done, abps = excluded.abps, ekyc = excluded.ekyc,
           last_seen = now()
     where t.status = 'new'
    returning 1)
  select count(*) into v_new from nw;

  insert into public.audit_logs (actor_id, gp_id, action, entity, details)
  values (auth.uid(), v_gp, 'flags_synced_kdesk', 'workers',
          jsonb_build_object('rows_in', v_in, 'matched', v_matched, 'changed', v_changed, 'run', p_run, 'restored', v_back, 'new_found', v_new,
                             'changes', (select coalesce(jsonb_agg(c), '[]'::jsonb) from (select c from jsonb_array_elements(v_changes) c limit 2000) t)));
  return jsonb_build_object('rows_in', v_in, 'matched', v_matched, 'changed', v_changed, 'restored', v_back, 'new_found', v_new);
end $function$;

revoke all on function public.kdesk_sync_flags(jsonb, uuid) from public, anon;
grant execute on function public.kdesk_sync_flags(jsonb, uuid) to authenticated;

-- ---------- Admin: how many are waiting (used by the Today page) ----------
create or replace function public.admin_portal_new_count(p_gp_id smallint)
 returns integer language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  return (select count(*) from public.portal_new_workers n
           where n.gp_id = p_gp_id and n.status = 'new'
             and not exists (select 1 from public.workers w where w.gp_id = n.gp_id and w.applicant_no = n.applicant_no
                               and private.norm_card(w.job_card_no) = n.job_card_no));
end $$;
revoke all on function public.admin_portal_new_count(smallint) from public, anon;
grant execute on function public.admin_portal_new_count(smallint) to authenticated;

-- ---------- Admin: the list (p_status 'new' | 'ignored') ----------
create or replace function public.admin_portal_new(p_gp_id smallint, p_status text default 'new')
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  if p_status not in ('new', 'ignored') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  return jsonb_build_object(
    'counts', jsonb_build_object(
       'new', (select count(*) from public.portal_new_workers n where n.gp_id = p_gp_id and n.status = 'new'
                 and not exists (select 1 from public.workers w where w.gp_id = n.gp_id and w.applicant_no = n.applicant_no
                                   and private.norm_card(w.job_card_no) = n.job_card_no)),
       'ignored', (select count(*) from public.portal_new_workers n where n.gp_id = p_gp_id and n.status = 'ignored'),
       'accepted', (select count(*) from public.portal_new_workers n where n.gp_id = p_gp_id and n.status = 'accepted')),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'job_card_no', n.job_card_no, 'applicant_no', n.applicant_no, 'applicant_name', n.applicant_name,
        'village_no', nullif(substring(n.job_card_no from '-([0-9]{3})/'), '')::integer,
        'new_card', not exists (select 1 from public.workers w2 where w2.gp_id = n.gp_id and private.norm_card(w2.job_card_no) = n.job_card_no),
        'abps', n.abps, 'ekyc', n.ekyc, 'first_seen', n.first_seen, 'last_seen', n.last_seen) order by n.job_card_no, n.applicant_no)
      from (select * from public.portal_new_workers x
             where x.gp_id = p_gp_id and x.status = p_status
               and not exists (select 1 from public.workers w where w.gp_id = x.gp_id and w.applicant_no = x.applicant_no
                                 and private.norm_card(w.job_card_no) = x.job_card_no)
             order by x.job_card_no, x.applicant_no limit 5000) n), '[]'::jsonb));
end $$;
revoke all on function public.admin_portal_new(smallint, text) from public, anon;
grant execute on function public.admin_portal_new(smallint, text) to authenticated;

-- ---------- Admin: accept / ignore / bring back ----------
-- p_action: 'accept' (add as active workers) | 'ignore' | 'unignore' (back to the New list)
create or replace function public.admin_portal_new_decide(p_gp_id smallint, p_ids bigint[], p_action text)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_n integer := 0; v_skip integer := 0;
begin
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 20000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if p_action = 'accept' then
    -- someone already in Gram Setu (e.g. imported meanwhile): just mark accepted
    update public.portal_new_workers n set status = 'accepted', decided_by = v_uid, decided_at = now(),
           worker_id = (select w.id from public.workers w where w.gp_id = n.gp_id and w.applicant_no = n.applicant_no
                          and private.norm_card(w.job_card_no) = n.job_card_no limit 1)
     where n.gp_id = p_gp_id and n.id = any (p_ids) and n.status = 'new'
       and exists (select 1 from public.workers w where w.gp_id = n.gp_id and w.applicant_no = n.applicant_no
                     and private.norm_card(w.job_card_no) = n.job_card_no);
    get diagnostics v_skip = row_count;

    with ins as (
      insert into public.workers (gp_id, job_card_no, applicant_no, applicant_name, aadhaar_seeded, authentication_done, abps, ekyc,
                                  active, village_no, household_no, household_suffix)
      select n.gp_id, n.job_card_no, n.applicant_no, n.applicant_name, n.aadhaar_seeded, n.authentication_done, n.abps, n.ekyc,
             true,
             substring(n.job_card_no from '-([0-9]{3})/')::integer,
             substring(n.job_card_no from '/([0-9]+)')::integer,
             substring(n.job_card_no from '-([A-Z])$')
        from public.portal_new_workers n
       where n.gp_id = p_gp_id and n.id = any (p_ids) and n.status = 'new'
      on conflict (gp_id, job_card_no, applicant_no) do nothing
      returning id, job_card_no, applicant_no)
    update public.portal_new_workers n set status = 'accepted', worker_id = ins.id, decided_by = v_uid, decided_at = now()
      from ins
     where n.gp_id = p_gp_id and n.job_card_no = ins.job_card_no and n.applicant_no = ins.applicant_no;
    get diagnostics v_n = row_count;
  elsif p_action = 'ignore' then
    update public.portal_new_workers set status = 'ignored', decided_by = v_uid, decided_at = now()
     where gp_id = p_gp_id and id = any (p_ids) and status = 'new';
    get diagnostics v_n = row_count;
  elsif p_action = 'unignore' then
    update public.portal_new_workers set status = 'new', decided_by = null, decided_at = null
     where gp_id = p_gp_id and id = any (p_ids) and status = 'ignored';
    get diagnostics v_n = row_count;
  else
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, details)
  values (v_uid, p_gp_id, 'portal_new_' || p_action, 'workers', jsonb_build_object('n', v_n, 'already_in', v_skip, 'asked', cardinality(p_ids)));
  return jsonb_build_object('changed', v_n, 'already_in', v_skip);
end $$;
revoke all on function public.admin_portal_new_decide(smallint, bigint[], text) from public, anon;
grant execute on function public.admin_portal_new_decide(smallint, bigint[], text) to authenticated;

-- ---------- Admin → Workers & Accounts: the tiles on top ----------
create or replace function public.admin_worker_stats(p_gp_id smallint)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v jsonb; v_since timestamptz;
begin
  -- "new" = added in the last 30 days, but not the GP's first big import (first day of data)
  select greatest(now() - interval '30 days', min(x.created_at) + interval '1 day') into v_since
    from public.workers x where x.gp_id = p_gp_id;
  v_since := coalesce(v_since, now() - interval '30 days');
  with acc as (select a.worker_id from public.worker_accounts a
                join public.workers x on x.id = a.worker_id and x.gp_id = p_gp_id
               where coalesce(btrim(a.account_no), '') <> ''),
       cards as (select x.job_card_no, min(x.created_at) first_at, bool_or(x.active) any_active
                   from public.workers x where x.gp_id = p_gp_id group by x.job_card_no)
  select jsonb_build_object(
      'workers',    count(*) filter (where w.active),
      'job_cards',  (select count(*) from cards c where c.any_active),
      'villages',   count(distinct w.village_no) filter (where w.active),
      'new_30',     count(*) filter (where w.active and w.created_at > v_since),
      'new_cards_30', (select count(*) from cards c where c.any_active and c.first_at > v_since),
      'removed',    count(*) filter (where not w.active and w.inactive_reason = 'portal_missing'),
      'inactive',   count(*) filter (where not w.active),
      'abps',       count(*) filter (where w.active and w.abps),
      'ekyc',       count(*) filter (where w.active and w.ekyc),
      'no_account', count(*) filter (where w.active and acc.worker_id is null))
    into v
    from public.workers w left join acc on acc.worker_id = w.id
   where w.gp_id = p_gp_id;
  return v || jsonb_build_object(
    'portal_new', (select count(*) from public.portal_new_workers n where n.gp_id = p_gp_id and n.status = 'new'
                     and not exists (select 1 from public.workers w where w.gp_id = n.gp_id and w.applicant_no = n.applicant_no
                                       and private.norm_card(w.job_card_no) = n.job_card_no)),
    'last_sync',   (select max(a.at) from public.audit_logs a where a.gp_id = p_gp_id and a.action = 'flags_synced_kdesk'),
    'new_since', v_since,
    'last_import', (select max(j.committed_at) from public.import_jobs j where j.gp_id = p_gp_id and j.committed_at is not null));
end $$;
revoke all on function public.admin_worker_stats(smallint) from public, anon;
grant execute on function public.admin_worker_stats(smallint) to authenticated;

select private.schema_mark(226, 'ABPS Sync keeps new portal workers → Admin accepts (portal_new_workers)');

commit;

notify pgrst, 'reload schema';
