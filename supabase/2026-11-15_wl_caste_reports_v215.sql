-- =====================================================================
-- Gram Setu — Wage List Caste Breakup reports from K-Desk (v215, 2026-11-15)
--
-- K-Desk (View Wagelist → ⚖ WL Caste Breakup) reads many wage lists at
-- once and makes the official Caste Breakup report (General / SC / ST per
-- Muster Roll). When the report is taken (Excel or Copy), K-Desk saves
-- which wage lists were reported here, so:
--   • the next report (on any PC) takes only the NEW wage lists;
--   • the Admin panel (⚖ WL Caste tab) shows every report batch and can
--     download its Excel again, or Undo it (the wage lists become "new"
--     again for K-Desk).
-- Only totals per wage list / Muster Roll and unmatched job card numbers are
-- stored: no names, no bank or Aadhaar data.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create table if not exists public.wl_caste_batches (
  id          bigint generated always as identity primary key,
  gp_id       smallint not null references public.gram_panchayats(id),
  kind        text not null default 'excel' check (kind in ('excel', 'copy')),
  fy          text,
  iay_only    boolean not null default false,
  wl_count    integer not null default 0,
  workers     integer not null default 0,
  amount      numeric(14, 2) not null default 0,
  first_wl    text,
  last_wl     text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists wl_caste_batches_gp on public.wl_caste_batches (gp_id, created_at desc);
alter table public.wl_caste_batches enable row level security;
revoke all on public.wl_caste_batches from anon, authenticated;

create table if not exists public.wl_caste_reports (
  id          bigint generated always as identity primary key,
  gp_id       smallint not null references public.gram_panchayats(id),
  batch_id    bigint not null references public.wl_caste_batches(id) on delete cascade,
  wl_no       text not null,
  wl_date     date,
  fy          text,
  workers     integer not null default 0,
  amount      numeric(14, 2) not null default 0,
  gen_amt     numeric(14, 2) not null default 0,
  sc_amt      numeric(14, 2) not null default 0,
  st_amt      numeric(14, 2) not null default 0,
  unknown_amt numeric(14, 2) not null default 0,
  page_total  numeric(14, 2),
  mrs         jsonb not null default '[]'::jsonb,   -- [{mr, g, sc, st, u, uj: [job card…]}]
  created_at  timestamptz not null default now()
);
create unique index if not exists wl_caste_reports_wl on public.wl_caste_reports (gp_id, upper(wl_no));
create index if not exists wl_caste_reports_batch on public.wl_caste_reports (batch_id);
alter table public.wl_caste_reports enable row level security;
revoke all on public.wl_caste_reports from anon, authenticated;

-- ---------- K-Desk ----------
-- wage list numbers already reported for this K-Desk login's GP
create or replace function public.kdesk_wl_caste_reported()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('wl', r.wl_no, 'at', r.created_at, 'b', r.batch_id) order by r.wl_no)
    from public.wl_caste_reports r where r.gp_id = v_gp), '[]'::jsonb);
end $$;

-- p_rows = [{wl, date "dd/mm/yyyy", n, amt, g, sc, st, u, page, mrs: [{mr, g, sc, st, u, uj: []}]}]
create or replace function public.kdesk_wl_caste_save(p_kind text, p_fy text, p_iay boolean, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_uid uuid := auth.uid(); v_b bigint; r jsonb; v_n int := 0; v_w int := 0; v_amt numeric := 0;
        v_first text; v_last text; v_d date;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  insert into public.wl_caste_batches (gp_id, kind, fy, iay_only, created_by)
  values (v_gp, case when p_kind = 'copy' then 'copy' else 'excel' end, left(nullif(p_fy, ''), 20), coalesce(p_iay, false), v_uid)
  returning id into v_b;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'wl', '') !~* '^[0-9A-Z]{0,20}WL[0-9]{1,12}$' then continue; end if;
    v_d := case when coalesce(r->>'date', '') ~ '^\d{1,2}/\d{1,2}/\d{4}$' then to_date(r->>'date', 'DD/MM/YYYY') else null end;
    insert into public.wl_caste_reports as t (gp_id, batch_id, wl_no, wl_date, fy, workers, amount, gen_amt, sc_amt, st_amt, unknown_amt, page_total, mrs)
    values (v_gp, v_b, upper(r->>'wl'), v_d, left(nullif(p_fy, ''), 20),
            coalesce((r->>'n')::int, 0), coalesce((r->>'amt')::numeric, 0), coalesce((r->>'g')::numeric, 0),
            coalesce((r->>'sc')::numeric, 0), coalesce((r->>'st')::numeric, 0), coalesce((r->>'u')::numeric, 0),
            nullif(r->>'page', '')::numeric,
            case when jsonb_typeof(r->'mrs') = 'array' then r->'mrs' else '[]'::jsonb end)
    on conflict (gp_id, upper(wl_no)) do update
      set batch_id = excluded.batch_id, wl_date = excluded.wl_date, fy = excluded.fy, workers = excluded.workers, amount = excluded.amount,
          gen_amt = excluded.gen_amt, sc_amt = excluded.sc_amt, st_amt = excluded.st_amt, unknown_amt = excluded.unknown_amt,
          page_total = excluded.page_total, mrs = excluded.mrs, created_at = now();
    v_n := v_n + 1; v_w := v_w + coalesce((r->>'n')::int, 0); v_amt := v_amt + coalesce((r->>'amt')::numeric, 0);
    if v_first is null or upper(r->>'wl') < v_first then v_first := upper(r->>'wl'); end if;
    if v_last is null or upper(r->>'wl') > v_last then v_last := upper(r->>'wl'); end if;
  end loop;
  if v_n = 0 then delete from public.wl_caste_batches where id = v_b; raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update public.wl_caste_batches set wl_count = v_n, workers = v_w, amount = v_amt, first_wl = v_first, last_wl = v_last where id = v_b;
  -- a batch whose wage lists all moved to a newer batch is empty now
  delete from public.wl_caste_batches b where b.gp_id = v_gp and b.id <> v_b and not exists (select 1 from public.wl_caste_reports x where x.batch_id = b.id);
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'wl_caste_report', 'wl_caste_batches', v_b::text, jsonb_build_object('wl', v_n, 'amount', v_amt));
  return jsonb_build_object('batch', v_b, 'wl', v_n);
end $$;

-- ---------- Admin ----------
create or replace function public.admin_wl_caste_batches(p_gp_id smallint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  -- counts are live (a wage list reported again moves to the newer batch)
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'fy', b.fy, 'iay', b.iay_only, 'at', b.created_at,
      'wl', s.wl, 'workers', s.workers, 'amount', s.amount, 'first', s.first_wl, 'last', s.last_wl,
      'gen', s.gen, 'sc', s.sc, 'st', s.st, 'unknown', s.unknown)
      order by b.created_at desc)
    from (select * from public.wl_caste_batches where gp_id = p_gp_id order by created_at desc limit 300) b
    cross join lateral (select count(*) as wl, coalesce(sum(r.workers), 0) as workers, coalesce(sum(r.amount), 0) as amount,
        min(r.wl_no) as first_wl, max(r.wl_no) as last_wl, coalesce(sum(r.gen_amt), 0) as gen, coalesce(sum(r.sc_amt), 0) as sc,
        coalesce(sum(r.st_amt), 0) as st, coalesce(sum(r.unknown_amt), 0) as unknown
      from public.wl_caste_reports r where r.batch_id = b.id) s), '[]'::jsonb);
end $$;

create or replace function public.admin_wl_caste_rows(p_batch_id bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := (select gp_id from public.wl_caste_batches where id = p_batch_id); v_uid uuid;
begin
  v_uid := private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'wl', r.wl_no, 'date', to_char(r.wl_date, 'DD/MM/YYYY'), 'n', r.workers, 'amt', r.amount, 'g', r.gen_amt, 'sc', r.sc_amt,
      'st', r.st_amt, 'u', r.unknown_amt, 'page', r.page_total, 'mrs', r.mrs) order by r.wl_no)
    from public.wl_caste_reports r where r.batch_id = p_batch_id), '[]'::jsonb);
end $$;

-- Undo: the batch's wage lists count as not reported again
create or replace function public.admin_wl_caste_undo(p_batch_id bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := (select gp_id from public.wl_caste_batches where id = p_batch_id); v_uid uuid; v_n int;
begin
  v_uid := private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  select wl_count into v_n from public.wl_caste_batches where id = p_batch_id;
  delete from public.wl_caste_batches where id = p_batch_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'wl_caste_undo', 'wl_caste_batches', p_batch_id::text, jsonb_build_object('wl', v_n));
  return jsonb_build_object('undone', coalesce(v_n, 0));
end $$;

-- ---------- grants ----------
revoke all on function public.kdesk_wl_caste_reported(), public.kdesk_wl_caste_save(text, text, boolean, jsonb),
  public.admin_wl_caste_batches(smallint), public.admin_wl_caste_rows(bigint), public.admin_wl_caste_undo(bigint) from public, anon;
grant execute on function public.kdesk_wl_caste_reported(), public.kdesk_wl_caste_save(text, text, boolean, jsonb),
  public.admin_wl_caste_batches(smallint), public.admin_wl_caste_rows(bigint), public.admin_wl_caste_undo(bigint) to authenticated;

select 'OK: Wage List Caste Breakup reports (v215) installed' as result;
