-- =====================================================================
-- G RAM-G 4A — MB books for every GP from the admin panel (v204, 2026-11-12)
-- Two ways, one continuous range of books from the Block per GP:
--  1. Range only  → iay_mb_preview (what would happen) + iay_mb_setup (save + allot in Job Card order)
--  2. Excel       → iay_mb_upload(rows, apply=false) checks, apply=true writes; works not in the
--                   file get the next free slots as in 1.
-- Rules: a work's MB/page never changes once one of its MRs is Filled / WL Generated;
-- the settings (first MB, pages) can change only while nothing is allotted (or after a reset,
-- which is refused once any allotted work has a filled MR). GP Admin: own GP only.
-- Requires v199/v203. Safe to run again.
-- =====================================================================

-- slot number of an MB/page in a GP's range (null if the page is not the start of a work's block)
create or replace function private.iay_mb_slot(s public.iay_mb_settings, p_mb int, p_pg int)
returns int language sql immutable set search_path to '' as $$
  select case when p_mb between s.first_mb and s.last_mb
               and p_pg between 1 and s.pages_per_mb - s.pages_per_work + 1
               and (p_pg - 1) % s.pages_per_work = 0
              then (p_mb - s.first_mb) * (s.pages_per_mb / s.pages_per_work) + (p_pg - 1) / s.pages_per_work + 1 end
$$;

-- works that need MB pages now (Ongoing or have an MR), in Job Card order
create or replace function private.iay_mb_need(p_prefix text)
returns table (work_code text, rn bigint) language sql stable security definer set search_path to '' as $$
  select w.work_code,
         row_number() over (order by
           case when w.jcn ~ '^WB-\d{2}-\d{3}-\d{3}-\d{3}/\d+' then substring(w.jcn from 15 for 3)::int end,
           case when w.jcn ~ '/\d+' then substring(w.jcn from '/(\d+)')::int end, w.jcn, w.work_code)
    from public.iay_works w
   where w.jc_prefix = p_prefix
     and (w.work_status = 'Ongoing' or exists (select 1 from public.iay_mrs r where r.work_code = w.work_code))
     and not exists (select 1 from public.iay_mb_allot a where a.work_code = w.work_code)
$$;
revoke all on function private.iay_mb_slot(public.iay_mb_settings, int, int), private.iay_mb_need(text) from public, anon, authenticated;

-- fill: free slots after the highest used one (then earlier gaps), in Job Card order, never past the last MB
create or replace function private.iay_mb_fill(p_prefix text)
returns integer language plpgsql security definer set search_path to '' as $$
declare s public.iay_mb_settings%rowtype; v_per int; v_cap int; v_max int; v_n int;
begin
  select * into s from public.iay_mb_settings where jc_prefix = p_prefix;
  if not found then return 0; end if;
  v_per := s.pages_per_mb / s.pages_per_work;
  v_cap := (s.last_mb - s.first_mb + 1) * v_per;
  select coalesce(max(sl), 0) into v_max from public.iay_mb_allot where jc_prefix = p_prefix;
  -- free slots: first the ones after the highest used slot, then gaps left earlier in the range
  with free as (
    select g sl, row_number() over (order by (g <= v_max), g) k
      from generate_series(1, v_cap) g
     where not exists (select 1 from public.iay_mb_allot a where a.jc_prefix = p_prefix and a.sl = g))
  insert into public.iay_mb_allot (work_code, jc_prefix, sl, mb_no, page_from)
  select t.work_code, p_prefix, f.sl,
         s.first_mb + (f.sl - 1) / v_per,
         ((f.sl - 1) % v_per) * s.pages_per_work + 1
    from private.iay_mb_need(p_prefix) t join free f on f.k = t.rn;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function private.iay_mb_fill(text) from public, anon, authenticated;

create or replace function private.iay_mb_locked(p_prefix text)
returns integer language sql stable security definer set search_path to '' as $$
  select count(distinct a.work_code)::int from public.iay_mb_allot a
   where a.jc_prefix = p_prefix
     and exists (select 1 from public.iay_mrs r where r.work_code = a.work_code and r.status in ('Filled', 'WL Generated'))
$$;
revoke all on function private.iay_mb_locked(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- What "Save & allot" would do (nothing is written)
create or replace function public.iay_mb_preview(p_jc_prefix text, p_first_mb integer, p_last_mb integer,
                                                p_pages_per_mb integer default 200, p_pages_per_work integer default 10)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope(); s public.iay_mb_settings%rowtype;
  v_per int; v_cap int; v_used int; v_base int; v_new int; v_need_total int;
begin
  if p_jc_prefix is null then raise exception 'PICK_ONE_GP'; end if;
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_first_mb is null or p_last_mb is null or p_last_mb < p_first_mb or p_pages_per_work < 1 or p_pages_per_mb < p_pages_per_work then raise exception 'BAD_INPUT'; end if;
  select * into s from public.iay_mb_settings where jc_prefix = p_jc_prefix;
  if found and exists (select 1 from public.iay_mb_allot where jc_prefix = p_jc_prefix) then
    -- allotted already: only the last MB can change; new works continue after the last slot
    p_first_mb := s.first_mb; p_pages_per_mb := s.pages_per_mb; p_pages_per_work := s.pages_per_work;
  end if;
  v_per := p_pages_per_mb / p_pages_per_work;
  v_cap := (p_last_mb - p_first_mb + 1) * v_per;
  select count(*), coalesce(max(sl), 0) into v_used, v_base from public.iay_mb_allot where jc_prefix = p_jc_prefix;
  select count(*) into v_new from private.iay_mb_need(p_jc_prefix);
  select count(*) into v_need_total from public.iay_works w where w.jc_prefix = p_jc_prefix;
  return jsonb_build_object(
    'first_mb', p_first_mb, 'last_mb', p_last_mb, 'pages_per_mb', p_pages_per_mb, 'pages_per_work', p_pages_per_work,
    'works_per_mb', v_per, 'capacity', v_cap, 'allotted', v_used, 'new', v_new,
    'works_total', v_need_total,
    'waiting_no_mr', (select count(*) from public.iay_works w where w.jc_prefix = p_jc_prefix and w.work_status <> 'Ongoing'
                        and not exists (select 1 from public.iay_mrs r where r.work_code = w.work_code)
                        and not exists (select 1 from public.iay_mb_allot a where a.work_code = w.work_code)),
    'fits', v_used + v_new <= v_cap,
    'first_new', case when v_new > 0 then jsonb_build_object('mb', p_first_mb + v_base / v_per, 'pg', (v_base % v_per) * p_pages_per_work + 1) end,
    'last_new', case when v_new > 0 then jsonb_build_object('mb', p_first_mb + (v_base + v_new - 1) / v_per, 'pg', ((v_base + v_new - 1) % v_per) * p_pages_per_work + 1) end,
    'free_after', greatest(v_cap - v_used - v_new, 0),
    'locked', private.iay_mb_locked(p_jc_prefix),
    'settings_fixed', s.jc_prefix is not null and v_used > 0);
end $$;

-- Save the range and allot (replaces v199's version: also checks the last MB covers what is used)
create or replace function public.iay_mb_setup(p_jc_prefix text, p_first_mb integer, p_last_mb integer,
                                              p_pages_per_mb integer default 200, p_pages_per_work integer default 10)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); v_new int; v_maxmb int; s public.iay_mb_settings%rowtype; v_per int;
begin
  if p_jc_prefix is null then raise exception 'PICK_ONE_GP'; end if;
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_first_mb is null or p_last_mb is null or p_last_mb < p_first_mb or p_first_mb < 1
     or p_pages_per_work < 1 or p_pages_per_mb < p_pages_per_work or p_pages_per_mb > 1000 or p_pages_per_work > 100 then raise exception 'BAD_INPUT'; end if;
  if exists (select 1 from public.iay_mb_allot where jc_prefix = p_jc_prefix) then
    if exists (select 1 from public.iay_mb_settings where jc_prefix = p_jc_prefix
                and (first_mb <> p_first_mb or pages_per_mb <> p_pages_per_mb or pages_per_work <> p_pages_per_work)) then
      raise exception 'MB_ALREADY_ALLOTTED';
    end if;
    select max(mb_no) into v_maxmb from public.iay_mb_allot where jc_prefix = p_jc_prefix;
    if p_last_mb < v_maxmb then raise exception 'LAST_MB_IN_USE' using detail = v_maxmb::text; end if;
  end if;
  insert into public.iay_mb_settings (jc_prefix, first_mb, last_mb, pages_per_mb, pages_per_work)
  values (p_jc_prefix, p_first_mb, p_last_mb, p_pages_per_mb, p_pages_per_work)
  on conflict (jc_prefix) do update set first_mb = excluded.first_mb, last_mb = excluded.last_mb,
         pages_per_mb = excluded.pages_per_mb, pages_per_work = excluded.pages_per_work, updated_at = now();
  -- nothing past the last MB
  select * into s from public.iay_mb_settings where jc_prefix = p_jc_prefix;
  v_per := s.pages_per_mb / s.pages_per_work;
  if (select count(*) from public.iay_mb_allot where jc_prefix = p_jc_prefix) + (select count(*) from private.iay_mb_need(p_jc_prefix))
     > (s.last_mb - s.first_mb + 1) * v_per then
    raise exception 'NOT_ENOUGH_BOOKS';
  end if;
  v_new := private.iay_mb_fill(p_jc_prefix);
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), (select id from public.gram_panchayats where jc_prefix = p_jc_prefix), 'iay_mb_setup', 'iay_mb', p_jc_prefix,
          jsonb_build_object('first_mb', p_first_mb, 'last_mb', p_last_mb, 'pages_per_mb', p_pages_per_mb, 'pages_per_work', p_pages_per_work, 'new', v_new));
  return jsonb_build_object('new_slots', v_new,
    'slots', (select count(*) from public.iay_mb_allot where jc_prefix = p_jc_prefix),
    'last_mb_used', (select max(mb_no) from public.iay_mb_allot where jc_prefix = p_jc_prefix));
end $$;

-- Start over (wrong range typed): refused once any allotted work has a Filled / WL Generated MR
create or replace function public.iay_mb_reset(p_jc_prefix text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); v_n int;
begin
  if p_jc_prefix is null then raise exception 'PICK_ONE_GP'; end if;
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if private.iay_mb_locked(p_jc_prefix) > 0 then raise exception 'MB_IN_USE' using detail = private.iay_mb_locked(p_jc_prefix)::text; end if;
  delete from public.iay_mb_allot where jc_prefix = p_jc_prefix;
  get diagnostics v_n = row_count;
  delete from public.iay_mb_settings where jc_prefix = p_jc_prefix;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), (select id from public.gram_panchayats where jc_prefix = p_jc_prefix), 'iay_mb_reset', 'iay_mb', p_jc_prefix, jsonb_build_object('removed', v_n));
  return jsonb_build_object('removed', v_n);
end $$;

-- Excel: rows [{ wc, mb, pg }] (pg = first page of the work). p_apply = false → only check.
-- The range must be saved first (form). Works not in the file then get the next free slots.
create or replace function public.iay_mb_upload(p_jc_prefix text, p_rows jsonb, p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope(); s public.iay_mb_settings%rowtype;
  v_err jsonb; v_nerr int; v_ok int; v_same int; v_new int := 0;
begin
  if p_jc_prefix is null then raise exception 'PICK_ONE_GP'; end if;
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then raise exception 'BAD_INPUT'; end if;
  select * into s from public.iay_mb_settings where jc_prefix = p_jc_prefix;
  if not found then raise exception 'MB_RANGE_FIRST'; end if;

  create temp table if not exists _mbu (i int, wc text, mb int, pg int, sl int, err text) on commit drop;
  truncate _mbu;
  insert into _mbu (i, wc, mb, pg)
  select o::int + 1, upper(trim(x->>'wc')),   -- i = Excel row (row 1 = header)
         case when x->>'mb' ~ '^\s*\d{1,6}\s*$' then trim(x->>'mb')::int end,
         case when x->>'pg' ~ '^\s*\d{1,4}\s*$' then trim(x->>'pg')::int end
    from jsonb_array_elements(p_rows) with ordinality t(x, o);
  update _mbu set sl = private.iay_mb_slot(s, mb, pg);

  update _mbu u set err = case
      when coalesce(u.wc, '') = '' then 'Work Code missing'
      when not exists (select 1 from public.iay_works w where upper(w.work_code) = u.wc and w.jc_prefix = p_jc_prefix) then 'Work Code not in this GP'
      when u.mb is null or u.pg is null then 'MB No / Page From missing or not a number'
      when u.mb not between s.first_mb and s.last_mb then 'MB ' || u.mb || ' is outside ' || s.first_mb || '–' || s.last_mb
      when u.sl is null then 'Page ' || u.pg || ' is not the start of a ' || s.pages_per_work || '-page block (1, ' || (1 + s.pages_per_work) || ', ' || (1 + 2 * s.pages_per_work) || ' …)'
    end;
  -- the same work twice / the same pages twice in the file
  update _mbu u set err = 'Work Code twice in the file (rows ' || (select string_agg(i::text, ', ' order by i) from _mbu z where z.wc = u.wc) || ')'
   where err is null and (select count(*) from _mbu z where z.wc = u.wc) > 1;
  update _mbu u set err = 'MB ' || u.mb || ' p' || u.pg || ' given to two works (rows ' || (select string_agg(i::text, ', ' order by i) from _mbu z where z.sl = u.sl) || ')'
   where err is null and (select count(*) from _mbu z where z.sl = u.sl and z.err is null) > 1;
  -- pages already held by another work that is not being moved by this file
  update _mbu u set err = 'MB ' || u.mb || ' p' || u.pg || ' already belongs to ' || a.work_code
    from public.iay_mb_allot a
   where u.err is null and a.jc_prefix = p_jc_prefix and a.sl = u.sl and upper(a.work_code) <> u.wc
     and not exists (select 1 from _mbu z where z.wc = upper(a.work_code) and z.err is null);
  -- a work whose MR is already paid keeps its pages
  update _mbu u set err = 'Already has MB ' || a.mb_no || ' p' || a.page_from || ' and a filled MR — cannot move'
    from public.iay_mb_allot a
   where u.err is null and upper(a.work_code) = u.wc and a.sl <> u.sl
     and exists (select 1 from public.iay_mrs r where r.work_code = a.work_code and r.status in ('Filled', 'WL Generated'));

  select count(*) filter (where err is not null), count(*) filter (where err is null),
         count(*) filter (where err is null and exists (select 1 from public.iay_mb_allot a where upper(a.work_code) = _mbu.wc and a.sl = _mbu.sl))
    into v_nerr, v_ok, v_same from _mbu;
  select coalesce(jsonb_agg(jsonb_build_object('row', i, 'wc', wc, 'mb', mb, 'pg', pg, 'err', err) order by i), '[]'::jsonb)
    into v_err from (select * from _mbu where err is not null order by i limit 200) e;

  if p_apply then
    if v_nerr > 0 then raise exception 'FIX_ERRORS_FIRST' using detail = v_nerr::text; end if;
    delete from public.iay_mb_allot a using _mbu u where upper(a.work_code) = u.wc;
    insert into public.iay_mb_allot (work_code, jc_prefix, sl, mb_no, page_from)
    select w.work_code, p_jc_prefix, u.sl, u.mb, u.pg
      from _mbu u join public.iay_works w on upper(w.work_code) = u.wc and w.jc_prefix = p_jc_prefix;
    v_new := private.iay_mb_fill(p_jc_prefix);
    insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
    values (auth.uid(), (select id from public.gram_panchayats where jc_prefix = p_jc_prefix), 'iay_mb_upload', 'iay_mb', p_jc_prefix,
            jsonb_build_object('rows', v_ok, 'auto_after', v_new));
  end if;
  return jsonb_build_object('rows', jsonb_array_length(p_rows), 'ok', v_ok, 'unchanged', v_same, 'errors', v_nerr, 'error_rows', v_err,
                            'applied', p_apply, 'auto_after', v_new,
                            'not_in_file', (select count(*) from private.iay_mb_need(p_jc_prefix) n where not exists (select 1 from _mbu u where u.wc = upper(n.work_code)))));
end $$;

revoke all on function public.iay_mb_preview(text, integer, integer, integer, integer), public.iay_mb_setup(text, integer, integer, integer, integer),
  public.iay_mb_reset(text), public.iay_mb_upload(text, jsonb, boolean) from public, anon;
grant execute on function public.iay_mb_preview(text, integer, integer, integer, integer), public.iay_mb_setup(text, integer, integer, integer, integer),
  public.iay_mb_reset(text), public.iay_mb_upload(text, jsonb, boolean) to authenticated;

select 'OK: MB setup for every GP installed' as result;
