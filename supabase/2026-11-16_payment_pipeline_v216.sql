-- =====================================================================
-- Gram Setu — Payment pipeline (v216, 2026-11-16)
--
-- One place in the Admin panel (💸 Pipeline tab) that shows where money
-- is stuck: Demand → Allocation → MR fill → Wage List → Send for payment.
--
-- What is new here (K-Desk v1.20.0 fills it, read-only on the portal):
--   pipeline_snaps  the latest list K-Desk SAW on two portal pages:
--       'wl_gen'   Generate Wagelist (SendMSRtoPO.aspx): works whose MR is
--                  filled but no wage list yet (+ held-back workers of the
--                  last Generate run)
--       'send_pay' Send Wagelist For Payment (sendforpay.aspx): wage lists
--                  not yet sent (+ amount when K-Desk read it)
--   pipeline_wls    wage lists K-Desk generated / sent (work code, amount)
--
-- Everything else comes from data that is already here: demand lists +
-- list_item_results (Demand / Allocation), IAY Tracker (PBA MRs).
-- No names, bank or Aadhaar data are stored.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create table if not exists public.pipeline_snaps (
  gp_id    smallint not null references public.gram_panchayats(id),
  kind     text not null check (kind in ('wl_gen', 'send_pay')),
  scope    text not null default '',            -- wl_gen: agency · send_pay: financial year
  items    jsonb not null default '[]'::jsonb,  -- wl_gen: [{code, name, held}] · send_pay: [{wl, amt}]
  n        integer not null default 0,
  amount   numeric(14, 2) not null default 0,
  seen_at  timestamptz not null default now(),
  seen_by  uuid,
  primary key (gp_id, kind, scope)
);
alter table public.pipeline_snaps enable row level security;
revoke all on public.pipeline_snaps from anon, authenticated;

create table if not exists public.pipeline_wls (
  gp_id        smallint not null references public.gram_panchayats(id),
  wl_no        text not null,
  fy           text,
  wl_date      date,
  work_code    text,
  workers      integer,
  amount       numeric(14, 2),
  stage        text not null default 'generated' check (stage in ('generated', 'sent')),
  generated_at timestamptz,
  sent_at      timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (gp_id, wl_no)
);
create index if not exists pipeline_wls_code on public.pipeline_wls (gp_id, work_code);
create index if not exists pipeline_wls_upd on public.pipeline_wls (gp_id, updated_at desc);
alter table public.pipeline_wls enable row level security;
revoke all on public.pipeline_wls from anon, authenticated;

-- ---------- K-Desk ----------
-- Replace what K-Desk saw on one page (one agency / one FY).
--   wl_gen  : p_items [{code, name, held}]
--   send_pay: p_items [{wl, amt}]   (amt kept from before when not read this time)
create or replace function public.kdesk_pipeline_snap(p_kind text, p_scope text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_uid uuid := auth.uid(); v_items jsonb; v_old jsonb; v_n int; v_amt numeric;
        v_scope text := left(coalesce(nullif(trim(p_scope), ''), ''), 60);
begin
  if p_kind not in ('wl_gen', 'send_pay') or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 3000 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_kind = 'wl_gen' then
    select coalesce(jsonb_agg(jsonb_build_object('code', upper(x->>'code'), 'name', left(coalesce(x->>'name', ''), 160),
                                                 'held', greatest(coalesce((x->>'held')::int, 0), 0)) order by x->>'code'), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(p_items) x
     where coalesce(x->>'code', '') ~ '^[0-9]{10}/[A-Za-z0-9/._-]{2,60}$';
    v_amt := 0;
  else
    select items into v_old from public.pipeline_snaps where gp_id = v_gp and kind = p_kind and scope = v_scope;
    select coalesce(jsonb_agg(jsonb_build_object('wl', upper(x->>'wl'),
             'amt', coalesce(nullif(x->>'amt', '')::numeric,
                             (select nullif(o->>'amt', '')::numeric from jsonb_array_elements(coalesce(v_old, '[]'::jsonb)) o
                               where upper(o->>'wl') = upper(x->>'wl') limit 1))) order by x->>'wl'), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(p_items) x
     where coalesce(x->>'wl', '') ~* '^[0-9A-Z]{0,20}WL[0-9]{1,12}$';
    select coalesce(sum(nullif(x->>'amt', '')::numeric), 0) into v_amt from jsonb_array_elements(v_items) x;
  end if;
  v_n := jsonb_array_length(v_items);
  insert into public.pipeline_snaps as t (gp_id, kind, scope, items, n, amount, seen_at, seen_by)
  values (v_gp, p_kind, v_scope, v_items, v_n, v_amt, now(), v_uid)
  on conflict (gp_id, kind, scope) do update
    set items = excluded.items, n = excluded.n, amount = excluded.amount, seen_at = now(), seen_by = excluded.seen_by;
  return jsonb_build_object('n', v_n);
end $$;

-- Wage lists K-Desk generated (Generate Wagelist run) or sent (Send for payment run).
--   p_rows [{wl, fy, date "dd/mm/yyyy", code, n, amt, stage 'generated'|'sent'}]
create or replace function public.kdesk_pipeline_wls(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); r jsonb; v_n int := 0; v_d date; v_st text;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'wl', '') !~* '^[0-9A-Z]{0,20}WL[0-9]{1,12}$' then continue; end if;
    v_st := case when r->>'stage' = 'sent' then 'sent' else 'generated' end;
    v_d := case when coalesce(r->>'date', '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(r->>'date', 'DD/MM/YYYY') else null end;
    insert into public.pipeline_wls as t (gp_id, wl_no, fy, wl_date, work_code, workers, amount, stage, generated_at, sent_at, updated_at)
    values (v_gp, upper(r->>'wl'), left(nullif(r->>'fy', ''), 20), v_d,
            case when coalesce(r->>'code', '') ~ '^[0-9]{10}/' then upper(left(r->>'code', 80)) end,
            nullif(r->>'n', '')::int, nullif(r->>'amt', '')::numeric, v_st,
            case when v_st = 'generated' then now() end, case when v_st = 'sent' then now() end, now())
    on conflict (gp_id, wl_no) do update
      set fy = coalesce(excluded.fy, t.fy), wl_date = coalesce(excluded.wl_date, t.wl_date),
          work_code = coalesce(excluded.work_code, t.work_code), workers = coalesce(excluded.workers, t.workers),
          amount = coalesce(excluded.amount, t.amount),
          stage = case when t.stage = 'sent' or excluded.stage = 'sent' then 'sent' else 'generated' end,
          generated_at = coalesce(t.generated_at, excluded.generated_at),
          sent_at = coalesce(t.sent_at, excluded.sent_at), updated_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('n', v_n);
end $$;

-- ---------- Admin ----------
create or replace function public.admin_pipeline(p_gp_id smallint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_pre text; v_t date := private.iay_today(); v_codes text[];
        v_lists jsonb; v_iay jsonb; v_snaps jsonb; v_wls jsonb; v_recent jsonb;
begin
  select jc_prefix into v_pre from public.gram_panchayats where id = p_gp_id;

  -- live demand lists with Demand / Allocation results
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.work_name, 'code', l.work_code, 'from', l.from_date, 'days', l.work_days,
      'state', l.submit_state, 'at', coalesce(l.submitted_at, l.created_at),
      'n', s.n, 'd_ok', s.d_ok, 'd_err', s.d_err, 'a_ok', s.a_ok, 'a_err', s.a_err,
      'r_at', s.r_at) order by coalesce(l.submitted_at, l.created_at) desc), '[]'::jsonb),
         coalesce(array_agg(upper(l.work_code)) filter (where l.work_code is not null), '{}')
    into v_lists, v_codes
    from (select * from public.demand_lists where gp_id = p_gp_id and deleted_at is null
           order by coalesce(submitted_at, created_at) desc limit 200) l
    cross join lateral (
      select count(i.worker_id)::int n,
             count(*) filter (where r.demand_status = 'done')::int d_ok,
             count(*) filter (where r.demand_status in ('error', 'skipped'))::int d_err,
             count(*) filter (where r.alloc_status = 'done')::int a_ok,
             count(*) filter (where r.alloc_status in ('error', 'skipped'))::int a_err,
             greatest(max(r.demand_at), max(r.alloc_at)) r_at
        from public.demand_list_items i
        left join public.list_item_results r on r.list_id = i.list_id and r.worker_id = i.worker_id
       where i.list_id = l.id and coalesce(i.active, true)) s;

  -- PBA / IAY works (IAY Tracker): MR fill due, filled waiting for a wage list
  select jsonb_build_object(
      'fill_due', count(*) filter (where m.end_date <= v_t and coalesce(m.status, '') not in ('Filled', 'WL Generated', 'Zero')),
      'fill_today', count(*) filter (where m.end_date = v_t and coalesce(m.status, '') not in ('Filled', 'WL Generated', 'Zero')),
      'running', count(*) filter (where m.end_date > v_t and coalesce(m.status, '') not in ('Filled', 'WL Generated', 'Zero')),
      'wl_wait', count(*) filter (where m.status = 'Filled'),
      'wl_done', count(*) filter (where m.status = 'WL Generated'),
      'report_at', (select max(w2.report_at) from public.iay_works w2 where w2.jc_prefix = v_pre))
    into v_iay
    from public.iay_mrs m join public.iay_works w on w.work_code = m.work_code
   where w.jc_prefix = v_pre and coalesce(w.work_status, '') <> 'Completed';

  select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'scope', s.scope, 'items', s.items, 'n', s.n,
                                               'amount', s.amount, 'at', s.seen_at) order by s.kind, s.scope), '[]'::jsonb)
    into v_snaps from public.pipeline_snaps s where s.gp_id = p_gp_id;

  -- wage lists of the lists' works + the last 60 days
  select coalesce(jsonb_agg(jsonb_build_object('wl', w.wl_no, 'fy', w.fy, 'date', w.wl_date, 'code', w.work_code, 'n', w.workers,
                                               'amt', w.amount, 'stage', w.stage, 'gen_at', w.generated_at, 'sent_at', w.sent_at)
                            order by w.updated_at desc), '[]'::jsonb)
    into v_wls
    from (select * from public.pipeline_wls w
           where w.gp_id = p_gp_id and (w.updated_at > now() - interval '60 days' or upper(w.work_code) = any (v_codes))
           order by w.updated_at desc limit 1500) w;

  return jsonb_build_object('today', v_t, 'lists', v_lists, 'iay', v_iay, 'snaps', v_snaps, 'wls', v_wls);
end $$;

-- ---------- grants ----------
revoke all on function public.kdesk_pipeline_snap(text, text, jsonb), public.kdesk_pipeline_wls(jsonb),
  public.admin_pipeline(smallint) from public, anon;
grant execute on function public.kdesk_pipeline_snap(text, text, jsonb), public.kdesk_pipeline_wls(jsonb),
  public.admin_pipeline(smallint) to authenticated;

select 'OK: Payment pipeline (v216) installed' as result;
