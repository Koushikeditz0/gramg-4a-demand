-- =====================================================================
-- G RAM-G 4A — IAY jobs for K-Desk Suite (v199, 2026-11-10)
--
-- Admin picks a list in the IAY Tracker and sends it to K-Desk as a job:
--   demand  → Work Code, Reg No (Job Card), Applicant, From, Days  (Demand, then Allocation)
--   attend  → Work Code, MR No                                     (MR Attendance only)
--   pay     → Work Code, MR No, MB No, Page No                     (MR Payment only)
-- K-Desk (kdesk login of the GP) lists the jobs, loads one into its panel, runs it
-- on the portal and sends each row's result back.
--
-- Demand days (first target 45 days = 3 MRs, then the next 45):
--   MRs done in the current block of 3: 0 → 42 days · 1 → 28 · 2 → 14 (never past 6 MRs)
-- MB pages: Ongoing works in Job Card order (village no, household no), 10 pages a work,
--   20 works an MB from the GP's first MB; MR n uses page_from + n − 1.
--   Works that become Ongoing later get the next free slot (nobody else moves).
-- Requires v198. Safe to run again.
-- =====================================================================

create table if not exists public.iay_mb_settings (
  jc_prefix      text primary key,
  first_mb       integer not null,
  last_mb        integer not null,
  pages_per_mb   integer not null default 200 check (pages_per_mb between 10 and 1000),
  pages_per_work integer not null default 10 check (pages_per_work between 1 and 100),
  updated_at     timestamptz not null default now()
);
create table if not exists public.iay_mb_allot (
  work_code  text primary key,
  jc_prefix  text not null,
  sl         integer not null,
  mb_no      integer not null,
  page_from  integer not null,
  created_at timestamptz not null default now(),
  unique (jc_prefix, sl)
);
create table if not exists public.iay_jobs (
  id          bigint generated always as identity primary key,
  jc_prefix   text not null,
  kind        text not null check (kind in ('demand', 'attend', 'pay')),
  title       text not null,
  items       jsonb not null,
  total       integer not null,
  results     jsonb not null default '{}'::jsonb,
  ok          integer not null default 0,
  failed      integer not null default 0,
  skipped     integer not null default 0,
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'cancelled')),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  picked_at   timestamptz,
  picked_by   uuid,
  updated_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists iay_jobs_gp_idx on public.iay_jobs (jc_prefix, created_at desc);
alter table public.iay_mb_settings enable row level security;
alter table public.iay_mb_allot enable row level security;
alter table public.iay_jobs enable row level security;
revoke all on public.iay_mb_settings, public.iay_mb_allot, public.iay_jobs from anon, authenticated;

-- Give every Ongoing work without a slot the next free one (Job Card order among the new ones).
create or replace function private.iay_mb_fill(p_prefix text)
returns integer language plpgsql security definer set search_path to '' as $$
declare s public.iay_mb_settings%rowtype; v_per int; v_n int;
begin
  select * into s from public.iay_mb_settings where jc_prefix = p_prefix;
  if not found then return 0; end if;
  v_per := s.pages_per_mb / s.pages_per_work;
  with base as (select coalesce(max(sl), 0) m from public.iay_mb_allot where jc_prefix = p_prefix),
  todo as (
    select w.work_code,
           row_number() over (order by
             case when w.jcn ~ '^WB-\d{2}-\d{3}-\d{3}-\d{3}/\d+' then substring(w.jcn from 15 for 3)::int end,
             case when w.jcn ~ '/\d+' then substring(w.jcn from '/(\d+)')::int end,
             w.jcn, w.work_code) rn
      from public.iay_works w
     where w.jc_prefix = p_prefix and w.work_status = 'Ongoing'
       and not exists (select 1 from public.iay_mb_allot a where a.work_code = w.work_code))
  insert into public.iay_mb_allot (work_code, jc_prefix, sl, mb_no, page_from)
  select t.work_code, p_prefix, b.m + t.rn,
         s.first_mb + (b.m + t.rn - 1) / v_per,
         ((b.m + t.rn - 1) % v_per) * s.pages_per_work + 1
    from todo t cross join base b;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- prefix of the logged-in kdesk account
create or replace function private.iay_kdesk_prefix()
returns text language sql stable security definer set search_path to '' as $$
  select g.jc_prefix from public.gram_panchayats g where g.id = private.require_kdesk()
$$;

-- final when K-Desk has nothing more to say about the row
create or replace function private.iay_job_tally(p_id bigint)
returns void language plpgsql security definer set search_path to '' as $$
declare j public.iay_jobs%rowtype; v_ok int := 0; v_bad int := 0; v_skip int := 0; v_final int := 0; r record;
begin
  select * into j from public.iay_jobs where id = p_id;
  for r in select value v from jsonb_each(j.results) loop
    if j.kind = 'demand' then
      if r.v->>'a' is not null then
        v_final := v_final + 1;
        if r.v->>'a' = 'done' then v_ok := v_ok + 1; elsif r.v->>'a' = 'skipped' then v_skip := v_skip + 1; else v_bad := v_bad + 1; end if;
      elsif r.v->>'d' in ('error', 'skipped') then
        v_final := v_final + 1;
        if r.v->>'d' = 'skipped' then v_skip := v_skip + 1; else v_bad := v_bad + 1; end if;
      end if;
    else
      v_final := v_final + 1;
      if r.v->>'s' = 'done' then v_ok := v_ok + 1; elsif r.v->>'s' = 'skipped' then v_skip := v_skip + 1; else v_bad := v_bad + 1; end if;
    end if;
  end loop;
  update public.iay_jobs set ok = v_ok, failed = v_bad, skipped = v_skip, updated_at = now(),
         status = case when status = 'cancelled' then status when v_final >= total then 'done' else 'running' end,
         done_at = case when v_final >= total and done_at is null then now() else done_at end
   where id = p_id;
end $$;

revoke all on function private.iay_mb_fill(text), private.iay_kdesk_prefix(), private.iay_job_tally(bigint) from public, anon;

-- ---------------------------------------------------------------------
-- Admin: MB settings for a GP (creating them also fills the slots)
create or replace function public.iay_mb_setup(p_jc_prefix text, p_first_mb integer, p_last_mb integer,
                                              p_pages_per_mb integer default 200, p_pages_per_work integer default 10)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); v_new int;
begin
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_first_mb is null or p_last_mb is null or p_last_mb < p_first_mb then raise exception 'BAD_INPUT'; end if;
  if exists (select 1 from public.iay_mb_allot where jc_prefix = p_jc_prefix)
     and exists (select 1 from public.iay_mb_settings where jc_prefix = p_jc_prefix
                  and (first_mb <> p_first_mb or pages_per_mb <> p_pages_per_mb or pages_per_work <> p_pages_per_work)) then
    raise exception 'MB_ALREADY_ALLOTTED';      -- only the last MB may change once pages are given out
  end if;
  insert into public.iay_mb_settings (jc_prefix, first_mb, last_mb, pages_per_mb, pages_per_work)
  values (p_jc_prefix, p_first_mb, p_last_mb, p_pages_per_mb, p_pages_per_work)
  on conflict (jc_prefix) do update set last_mb = excluded.last_mb, updated_at = now();
  v_new := private.iay_mb_fill(p_jc_prefix);
  return jsonb_build_object('new_slots', v_new,
    'slots', (select count(*) from public.iay_mb_allot where jc_prefix = p_jc_prefix),
    'last_mb_used', (select max(mb_no) from public.iay_mb_allot where jc_prefix = p_jc_prefix));
end $$;

-- Admin: make a job from a Tracker list
--   p_source: demand → mr_gap | mr_due5 | mr_start_on (p_date) | no_mr (p_date = From)
--             attend / pay → older | day (p_date) | all   (as in iay_pending_list, p_past days)
create or replace function public.iay_job_create(p_jc_prefix text, p_kind text, p_source text,
                                                p_date date default null, p_past integer default 2, p_title text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope(); v_t date := private.iay_today();
  v_items jsonb; v_out int := 0; v_id bigint; v_list jsonb;
begin
  if p_jc_prefix is null then raise exception 'PICK_ONE_GP'; end if;
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_kind not in ('demand', 'attend', 'pay') then raise exception 'BAD_KIND'; end if;

  if p_kind = 'demand' then
    if p_source not in ('mr_gap', 'mr_due5', 'mr_start_on', 'no_mr') then raise exception 'BAD_SOURCE'; end if;
    if p_source in ('mr_start_on', 'no_mr') and p_date is null then raise exception 'BAD_DATE'; end if;
    with s as (
      select x.*,
             coalesce(x.next_start, case when p_source = 'no_mr' then p_date end) as from_d,
             14 * least(3 - (x.n_eff % 3), x.remaining) as days
        from private.iay_state(p_jc_prefix) x
       where case p_source
               when 'mr_gap' then x.next_start <= v_t
               when 'mr_due5' then x.next_start > v_t and x.next_start <= v_t + 5
               when 'mr_start_on' then x.next_start = p_date
               else x.n_all = 0
             end and x.remaining > 0)
    select coalesce(jsonb_agg(jsonb_build_object('work_code', work_code, 'reg', jcn,
                      'app', trim(split_part(ben_name, ' (+', 1)), 'from', to_char(from_d, 'DD/MM/YYYY'), 'days', days)
                      order by jcn) filter (where coalesce(jcn, '') <> '' and coalesce(ben_name, '') <> '' and from_d is not null), '[]'::jsonb),
           count(*) filter (where not (coalesce(jcn, '') <> '' and coalesce(ben_name, '') <> '' and from_d is not null))
      into v_items, v_out from s;
  else
    if p_source not in ('older', 'day', 'all') then raise exception 'BAD_SOURCE'; end if;
    if p_kind = 'pay' then perform private.iay_mb_fill(p_jc_prefix); end if;
    v_list := private.iay_pending_core(v_scope, p_jc_prefix, p_source, p_date, p_past);
    select coalesce(jsonb_agg(case when p_kind = 'attend'
                                then jsonb_build_object('work_code', x->>'work_code', 'mr', x->>'mr_no', 'end', x->>'end')
                                else jsonb_build_object('work_code', x->>'work_code', 'mr', x->>'mr_no', 'end', x->>'end',
                                                        'mb', a.mb_no, 'page', a.page_from + coalesce((x->>'seq')::int, 1) - 1) end
                              order by x->>'work_code', (x->>'seq')::int, x->>'mr_no')
                      filter (where p_kind = 'attend' or a.mb_no is not null), '[]'::jsonb),
           count(*) filter (where p_kind = 'pay' and a.mb_no is null)
      into v_items, v_out
      from jsonb_array_elements(v_list) x
      left join public.iay_mb_allot a on a.work_code = x->>'work_code';
  end if;

  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('job_id', null, 'total', 0, 'left_out', v_out);
  end if;
  insert into public.iay_jobs (jc_prefix, kind, title, items, total, created_by)
  values (p_jc_prefix, p_kind, left(coalesce(nullif(p_title, ''), p_kind || ' ' || to_char(v_t, 'DD/MM')), 150),
          v_items, jsonb_array_length(v_items), auth.uid())
  returning id into v_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), (select id from public.gram_panchayats where jc_prefix = p_jc_prefix), 'iay_job_create', 'iay_jobs', v_id::text,
          jsonb_build_object('kind', p_kind, 'source', p_source, 'total', jsonb_array_length(v_items), 'left_out', v_out));
  return jsonb_build_object('job_id', v_id, 'total', jsonb_array_length(v_items), 'left_out', v_out);
end $$;

create or replace function public.iay_jobs_list(p_jc_prefix text default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); v_p text := coalesce(v_scope, p_jc_prefix);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'jc_prefix', jc_prefix, 'kind', kind, 'title', title, 'total', total,
                     'ok', ok, 'failed', failed, 'skipped', skipped, 'status', status, 'created_at', created_at,
                     'picked_at', picked_at, 'updated_at', updated_at, 'done_at', done_at) order by created_at desc)
                     from (select * from public.iay_jobs where v_p is null or jc_prefix = v_p order by created_at desc limit 40) j), '[]'::jsonb);
end $$;

-- rows of one job with their results (for the admin's Excel)
create or replace function public.iay_job_detail(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); j public.iay_jobs%rowtype;
begin
  select * into j from public.iay_jobs where id = p_id;
  if not found or (v_scope is not null and v_scope <> j.jc_prefix) then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('job', jsonb_build_object('id', j.id, 'kind', j.kind, 'title', j.title, 'status', j.status),
                            'items', j.items, 'results', j.results);
end $$;

create or replace function public.iay_job_cancel(p_id bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); j public.iay_jobs%rowtype;
begin
  select * into j from public.iay_jobs where id = p_id;
  if not found or (v_scope is not null and v_scope <> j.jc_prefix) then raise exception 'NOT_FOUND'; end if;
  update public.iay_jobs set status = 'cancelled', updated_at = now() where id = p_id and status in ('queued', 'running');
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- K-Desk (kdesk login of the GP)
create or replace function public.kdesk_iay_jobs(p_kind text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_p text := private.iay_kdesk_prefix();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'total', total, 'status', status,
                     'ok', ok, 'failed', failed, 'skipped', skipped, 'created_at', created_at, 'picked_at', picked_at) order by created_at desc)
                     from public.iay_jobs where jc_prefix = v_p and kind = p_kind and status in ('queued', 'running')), '[]'::jsonb);
end $$;

create or replace function public.kdesk_iay_job_take(p_id bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_p text := private.iay_kdesk_prefix(); j public.iay_jobs%rowtype;
begin
  select * into j from public.iay_jobs where id = p_id and jc_prefix = v_p and status in ('queued', 'running');
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  update public.iay_jobs set status = 'running', picked_at = coalesce(picked_at, now()), picked_by = auth.uid(), updated_at = now() where id = p_id;
  return jsonb_build_object('id', j.id, 'kind', j.kind, 'title', j.title, 'items', j.items);
end $$;

-- p_rows: [{ key, s: done|error|skipped, m }]; key = work_code (demand/alloc) or work_code|mr (attend/pay)
create or replace function public.kdesk_iay_report(p_id bigint, p_stage text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_p text := private.iay_kdesk_prefix(); j public.iay_jobs%rowtype; v_add jsonb; f text;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'BAD_INPUT'; end if;
  select * into j from public.iay_jobs where id = p_id and jc_prefix = v_p for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  f := case p_stage when 'demand' then 'd' when 'alloc' then 'a' else 's' end;
  if (j.kind = 'demand') <> (p_stage in ('demand', 'alloc')) then raise exception 'BAD_STAGE'; end if;
  select coalesce(jsonb_object_agg(k, coalesce(j.results->k, '{}'::jsonb) || jsonb_build_object(f, s, f || 'm', m, f || 't', now())), '{}'::jsonb)
    into v_add
    from (select distinct on (x->>'key') left(x->>'key', 120) k, x->>'s' s, left(coalesce(x->>'m', ''), 300) m
            from jsonb_array_elements(p_rows) x
           where x->>'s' in ('done', 'error', 'skipped') and coalesce(x->>'key', '') <> '') y;
  update public.iay_jobs set results = results || v_add, updated_at = now() where id = p_id;
  perform private.iay_job_tally(p_id);
  return (select jsonb_build_object('ok', ok, 'failed', failed, 'skipped', skipped, 'status', status) from public.iay_jobs where id = p_id);
end $$;

revoke all on function public.iay_mb_setup(text, integer, integer, integer, integer), public.iay_job_create(text, text, text, date, integer, text),
  public.iay_jobs_list(text), public.iay_job_detail(bigint), public.iay_job_cancel(bigint),
  public.kdesk_iay_jobs(text), public.kdesk_iay_job_take(bigint), public.kdesk_iay_report(bigint, text, jsonb) from public, anon;
grant execute on function public.iay_mb_setup(text, integer, integer, integer, integer), public.iay_job_create(text, text, text, date, integer, text),
  public.iay_jobs_list(text), public.iay_job_detail(bigint), public.iay_job_cancel(bigint),
  public.kdesk_iay_jobs(text), public.kdesk_iay_job_take(bigint), public.kdesk_iay_report(bigint, text, jsonb) to authenticated;

-- MB line for the Tracker's job card
create or replace function public.iay_mb_status(p_jc_prefix text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); v_p text := coalesce(v_scope, p_jc_prefix); s public.iay_mb_settings%rowtype;
begin
  if v_p is null then return null; end if;
  select * into s from public.iay_mb_settings where jc_prefix = v_p;
  if not found then return jsonb_build_object('first_mb', null); end if;
  return jsonb_build_object('first_mb', s.first_mb, 'last_mb', s.last_mb, 'pages_per_work', s.pages_per_work,
    'slots', (select count(*) from public.iay_mb_allot where jc_prefix = v_p),
    'last_used', (select max(mb_no) from public.iay_mb_allot where jc_prefix = v_p),
    'waiting', (select count(*) from public.iay_works w where w.jc_prefix = v_p and w.work_status = 'Ongoing'
                  and not exists (select 1 from public.iay_mb_allot a where a.work_code = w.work_code)));
end $$;
revoke all on function public.iay_mb_status(text) from public, anon;
grant execute on function public.iay_mb_status(text) to authenticated;

-- Petla: MBs 939–1031 issued by the Block (10 pages a work, 200 a book)
insert into public.iay_mb_settings (jc_prefix, first_mb, last_mb, pages_per_mb, pages_per_work)
values ('WB-08-005-014', 939, 1031, 200, 10) on conflict (jc_prefix) do nothing;
select private.iay_mb_fill('WB-08-005-014');

select 'OK: IAY K-Desk jobs installed' as result;
