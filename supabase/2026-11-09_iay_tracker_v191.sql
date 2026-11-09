-- =====================================================================
-- G RAM-G 4A — IAY (State Scheme House) Tracker (v191, 2026-11-09)
--
-- Keeps the latest "IAY Phase Report" (Tampermonkey, VB-G RAM G portal)
-- per GP and works out, for every IAY work:
--   * how many MRs it has (target 6 MRs x 15 days = 90 mandays)
--   * which MRs must be filled (MR end date = fill date)
--   * when the next MR must start (day after the last MR ends)
--   * filled MRs still waiting for a wagelist
--
-- New tables only (iay_works, iay_mrs, iay_imports). Nothing existing changes.
-- Read/write only through the functions below (RLS on, no table policies):
--   iay_import_gp(...)        Super Admin: any GP · GP Admin: own GP only
--   iay_overview(p_jc_prefix) GP-wise counts + 35-day calendar
--   iay_list(p_jc_prefix, p_kind, p_date)  rows for a card / calendar day
--
-- Safe to run again.
-- =====================================================================

create table if not exists public.iay_works (
  work_code   text primary key check (char_length(work_code) between 5 and 60),
  jc_prefix   text not null check (jc_prefix ~ '^WB-[0-9]{2}-[0-9]{3}-[0-9]{3}$'),
  gp_name     text not null,
  reg_no      text,
  ben_name    text,
  jcn         text,
  village     text,
  work_status text,
  mandays     integer,
  wl_info     text,
  wl_no       text,
  wl_date     date,
  report_at   timestamptz,
  updated_at  timestamptz not null default now()
);
create index if not exists iay_works_prefix_idx on public.iay_works (jc_prefix);

create table if not exists public.iay_mrs (
  work_code  text not null references public.iay_works (work_code) on delete cascade,
  mr_no      bigint not null,
  seq        smallint,
  start_date date not null,
  end_date   date not null,
  status     text,
  primary key (work_code, mr_no)
);
create index if not exists iay_mrs_end_idx on public.iay_mrs (end_date);

create table if not exists public.iay_imports (
  id          bigint generated always as identity primary key,
  jc_prefix   text not null,
  gp_name     text not null,
  works       integer not null,
  mrs         integer not null,
  report_at   timestamptz,
  file_name   text,
  imported_by uuid,
  at          timestamptz not null default now()
);
create index if not exists iay_imports_prefix_idx on public.iay_imports (jc_prefix, at desc);

alter table public.iay_works   enable row level security;
alter table public.iay_mrs     enable row level security;
alter table public.iay_imports enable row level security;
revoke all on public.iay_works, public.iay_mrs, public.iay_imports from anon, authenticated;

-- ---------------------------------------------------------------------
-- Scope: NULL = Super Admin (all GPs), else the GP Admin's own jc_prefix.
create or replace function private.iay_scope()
returns text language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.admin_scope();
begin
  if v_gp is null then return null; end if;
  return (select g.jc_prefix from public.gram_panchayats g where g.id = v_gp);
end $$;

-- India date (the portal works in IST)
create or replace function private.iay_today()
returns date language sql stable set search_path to '' as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

-- One row per work with its MR position.
--   n_eff   : MRs that count towards the 90 days (14+ days long, not Zero)
--   last_end: end of the last MR (any length)
--   next_start: day the next MR must start (NULL when 6 MRs are there or no MR yet)
create or replace function private.iay_state(p_prefix text)
returns table (work_code text, jc_prefix text, gp_name text, reg_no text, ben_name text, jcn text, village text,
               n_all integer, n_eff integer, last_end date, next_start date, remaining integer)
language sql stable security definer set search_path to '' as $$
  with m as (
    select r.work_code,
           count(*)::int as n_all,
           (count(*) filter (where r.end_date - r.start_date + 1 >= 14 and coalesce(r.status, '') <> 'Zero'))::int as n_eff,
           max(r.end_date) as last_end
      from public.iay_mrs r
      join public.iay_works w2 on w2.work_code = r.work_code
     where p_prefix is null or w2.jc_prefix = p_prefix
     group by r.work_code)
  select w.work_code, w.jc_prefix, w.gp_name, w.reg_no, w.ben_name, w.jcn, w.village,
         coalesce(m.n_all, 0), coalesce(m.n_eff, 0), m.last_end,
         case when coalesce(m.n_eff, 0) < 6 and m.last_end is not null then m.last_end + 1 end,
         greatest(6 - coalesce(m.n_eff, 0), 0)
    from public.iay_works w
    left join m on m.work_code = w.work_code
   where (p_prefix is null or w.jc_prefix = p_prefix)
     and coalesce(w.work_status, '') <> 'Completed'
$$;

revoke all on function private.iay_scope(), private.iay_today(), private.iay_state(text) from public, anon;

-- ---------------------------------------------------------------------
-- Import one GP of a Phase Report. Replaces that GP's previous data.
--   p_works: [{work_code, reg_no, ben_name, jcn, village, work_status, mandays, wl_info, wl_no, wl_date}]
--   p_mrs  : [{work_code, mr_no, seq, start_date, end_date, status}]
create or replace function public.iay_import_gp(p_jc_prefix text, p_gp_name text, p_report_at timestamptz,
                                               p_file_name text, p_works jsonb, p_mrs jsonb, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := auth.uid();
  v_scope text := private.iay_scope();
  v_last timestamptz;
  v_bad int; v_w int; v_m int;
begin
  if p_jc_prefix is null or p_jc_prefix !~ '^WB-[0-9]{2}-[0-9]{3}-[0-9]{3}$' then raise exception 'BAD_GP'; end if;
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if jsonb_typeof(p_works) <> 'array' or jsonb_array_length(p_works) = 0 then raise exception 'NO_WORKS'; end if;

  -- every work must belong to this GP (Job Card prefix)
  select count(*) into v_bad from jsonb_array_elements(p_works) x
   where left(coalesce(x->>'jcn', ''), 13) <> p_jc_prefix or coalesce(x->>'work_code', '') = '';
  if v_bad > 0 then raise exception 'WRONG_GP_ROWS' using detail = v_bad || ' rows'; end if;

  -- refuse an older report over a newer one (unless forced)
  select max(report_at) into v_last from public.iay_imports where jc_prefix = p_jc_prefix;
  if not coalesce(p_force, false) and v_last is not null and p_report_at is not null and p_report_at < v_last then
    raise exception 'OLDER_REPORT';
  end if;

  delete from public.iay_works where jc_prefix = p_jc_prefix;

  insert into public.iay_works (work_code, jc_prefix, gp_name, reg_no, ben_name, jcn, village, work_status,
                                mandays, wl_info, wl_no, wl_date, report_at)
  select distinct on (x->>'work_code')
         x->>'work_code', p_jc_prefix, p_gp_name, nullif(x->>'reg_no', ''), nullif(x->>'ben_name', ''), x->>'jcn',
         nullif(x->>'village', ''), nullif(x->>'work_status', ''),
         case when x->>'mandays' ~ '^[0-9]+$' then (x->>'mandays')::int end,
         nullif(x->>'wl_info', ''), nullif(x->>'wl_no', ''),
         case when x->>'wl_date' ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'wl_date')::date end,
         p_report_at
    from jsonb_array_elements(p_works) x
   order by x->>'work_code';
  get diagnostics v_w = row_count;

  insert into public.iay_mrs (work_code, mr_no, seq, start_date, end_date, status)
  select distinct on (x->>'work_code', (x->>'mr_no')::bigint)
         x->>'work_code', (x->>'mr_no')::bigint, (x->>'seq')::smallint,
         (x->>'start_date')::date, (x->>'end_date')::date, nullif(x->>'status', '')
    from jsonb_array_elements(coalesce(p_mrs, '[]'::jsonb)) x
    join public.iay_works w on w.work_code = x->>'work_code'
   where x->>'mr_no' ~ '^[0-9]+$'
     and x->>'start_date' ~ '^\d{4}-\d{2}-\d{2}$' and x->>'end_date' ~ '^\d{4}-\d{2}-\d{2}$'
   order by x->>'work_code', (x->>'mr_no')::bigint;
  get diagnostics v_m = row_count;

  insert into public.iay_imports (jc_prefix, gp_name, works, mrs, report_at, file_name, imported_by)
  values (p_jc_prefix, p_gp_name, v_w, v_m, p_report_at, left(p_file_name, 200), v_uid);

  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, (select id from public.gram_panchayats where jc_prefix = p_jc_prefix), 'iay_import', 'iay', p_jc_prefix,
          jsonb_build_object('gp', p_gp_name, 'works', v_w, 'mrs', v_m, 'report_at', p_report_at));

  return jsonb_build_object('works', v_w, 'mrs', v_m);
end $$;

-- ---------------------------------------------------------------------
-- GP-wise counts + calendar. Super Admin may pass NULL for all GPs.
create or replace function public.iay_overview(p_jc_prefix text default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope();
  v_p text := coalesce(v_scope, p_jc_prefix);
  v_t date := private.iay_today();
  v_out jsonb;
begin
  with s as (select * from private.iay_state(v_p)),
  open_mr as (
    select w.jc_prefix, r.end_date
      from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
     where (v_p is null or w.jc_prefix = v_p)
       and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')),
  wl as (
    select w.jc_prefix, count(*) n
      from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
     where (v_p is null or w.jc_prefix = v_p) and r.status = 'Filled'
     group by 1),
  gps as (
    select s.jc_prefix, max(s.gp_name) gp_name, count(*) works,
           count(*) filter (where s.n_all = 0) no_mr,
           count(*) filter (where s.n_eff >= 6) done6,
           round(avg(s.n_eff), 1) avg_mrs,
           count(*) filter (where s.next_start <= v_t) mr_gap,
           count(*) filter (where s.next_start > v_t and s.next_start <= v_t + 5) mr_due5,
           max(s.last_end + 16 * s.remaining) filter (where s.last_end is not null) finish_by
      from s group by s.jc_prefix),
  fills as (
    select jc_prefix,
           count(*) filter (where end_date < v_t) fill_overdue,
           count(*) filter (where end_date = v_t) fill_today,
           count(*) filter (where end_date = v_t + 1) fill_tomorrow
      from open_mr group by 1),
  rep as (
    select distinct on (jc_prefix) jc_prefix, report_at, at
      from public.iay_imports where v_p is null or jc_prefix = v_p
     order by jc_prefix, at desc)
  select jsonb_build_object(
    'today', v_t,
    'scope', v_scope,
    'gps', coalesce((select jsonb_agg(jsonb_build_object(
              'jc_prefix', g.jc_prefix, 'gp_name', g.gp_name, 'works', g.works, 'no_mr', g.no_mr,
              'done6', g.done6, 'avg_mrs', g.avg_mrs, 'mr_gap', g.mr_gap, 'mr_due5', g.mr_due5,
              'finish_by', g.finish_by,
              'fill_overdue', coalesce(f.fill_overdue, 0), 'fill_today', coalesce(f.fill_today, 0),
              'fill_tomorrow', coalesce(f.fill_tomorrow, 0), 'wl_pending', coalesce(wl.n, 0),
              'report_at', r.report_at, 'imported_at', r.at) order by g.gp_name)
            from gps g left join fills f using (jc_prefix) left join wl using (jc_prefix) left join rep r using (jc_prefix)), '[]'::jsonb),
    'calendar', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'fill', fl, 'mr_start', ms) order by d) from (
              select d::date d,
                     (select count(*) from open_mr o where o.end_date = d::date) fl,
                     (select count(*) from s where s.next_start = d::date) ms
                from generate_series(v_t, v_t + 34, interval '1 day') d) c
             where fl > 0 or ms > 0), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- Rows behind a card or a calendar day (for the screen and Excel).
--   kinds: fill_overdue · fill_on (p_date) · mr_gap · mr_due5 · mr_start_on (p_date)
--          wl_pending · no_mr · done6 · all
create or replace function public.iay_list(p_jc_prefix text, p_kind text, p_date date default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope();
  v_p text := coalesce(v_scope, p_jc_prefix);
  v_t date := private.iay_today();
begin
  if p_kind in ('fill_overdue', 'fill_on', 'wl_pending') then
    return coalesce((
      select jsonb_agg(jsonb_build_object(
               'gp', w.gp_name, 'work_code', w.work_code, 'reg_no', w.reg_no, 'name', w.ben_name, 'jcn', w.jcn,
               'village', w.village, 'mr_no', r.mr_no, 'seq', r.seq, 'start', r.start_date, 'end', r.end_date,
               'status', r.status) order by w.gp_name, r.end_date, r.mr_no)
        from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
       where (v_p is null or w.jc_prefix = v_p)
         and case p_kind
               when 'wl_pending' then r.status = 'Filled'
               when 'fill_overdue' then r.end_date < v_t and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')
               else r.end_date = coalesce(p_date, v_t) and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')
             end), '[]'::jsonb);
  end if;

  if p_kind not in ('mr_gap', 'mr_due5', 'mr_start_on', 'no_mr', 'done6', 'all') then raise exception 'BAD_KIND'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'gp', s.gp_name, 'work_code', s.work_code, 'reg_no', s.reg_no, 'name', s.ben_name, 'jcn', s.jcn,
             'village', s.village, 'mrs', s.n_eff, 'remaining', s.remaining, 'last_end', s.last_end,
             'next_start', s.next_start,
             'finish_by', case when s.last_end is not null then s.last_end + 16 * s.remaining end)
             order by s.gp_name, s.next_start, s.jcn)
      from private.iay_state(v_p) s
     where case p_kind
             when 'mr_gap' then s.next_start <= v_t
             when 'mr_due5' then s.next_start > v_t and s.next_start <= v_t + 5
             when 'mr_start_on' then s.next_start = coalesce(p_date, v_t)
             when 'no_mr' then s.n_all = 0
             when 'done6' then s.n_eff >= 6
             else true
           end), '[]'::jsonb);
end $$;

revoke all on function public.iay_import_gp(text, text, timestamptz, text, jsonb, jsonb, boolean),
                       public.iay_overview(text), public.iay_list(text, text, date) from public, anon;
grant execute on function public.iay_import_gp(text, text, timestamptz, text, jsonb, jsonb, boolean),
                          public.iay_overview(text), public.iay_list(text, text, date) to authenticated;

select 'OK: IAY tracker installed' as result;
