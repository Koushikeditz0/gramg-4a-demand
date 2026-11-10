-- =====================================================================
-- G RAM-G 4A — "pending in the last hour" for the MR Summary (v202, 2026-11-10)
-- Every import (Pi sync / Tampermonkey / Excel) now stores the GP's Total pending
-- (MRs ended on or before today, not Filled / WL Generated / Zero) and WL pending
-- in iay_imports. The summary sends, per GP, the value from the newest import at least
-- 55 minutes old, so the page can show e.g. "▼400 since 09:40".
-- Requires v196+. Safe to run again.
-- =====================================================================

alter table public.iay_imports add column if not exists pend integer;
alter table public.iay_imports add column if not exists wl integer;

create or replace function private.iay_import_snap()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_t date := private.iay_today();
begin
  -- the import has already replaced this GP's works and MRs in the same transaction
  select count(*) filter (where r.end_date <= v_t and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')),
         count(*) filter (where r.status = 'Filled')
    into new.pend, new.wl
    from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
   where w.jc_prefix = new.jc_prefix;
  return new;
end $$;
revoke all on function private.iay_import_snap() from public, anon, authenticated;

drop trigger if exists iay_import_snap on public.iay_imports;
create trigger iay_import_snap before insert on public.iay_imports
  for each row execute function private.iay_import_snap();

-- baseline: the newest import of each GP is what the tables hold now
update public.iay_imports i set pend = s.pend, wl = s.wl
  from (select w.jc_prefix,
               count(*) filter (where r.end_date <= private.iay_today() and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')) pend,
               count(*) filter (where r.status = 'Filled') wl
          from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code group by 1) s
 where i.jc_prefix = s.jc_prefix and i.pend is null
   and i.at = (select max(at) from public.iay_imports x where x.jc_prefix = i.jc_prefix);

create or replace function private.iay_summary_core(p_scope text, p_past integer, p_ahead integer)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_t date := private.iay_today();
  v_past int := least(greatest(coalesce(p_past, 2), 0), 14);
  v_ahead int := least(greatest(coalesce(p_ahead, 5), 0), 14);
begin
  return jsonb_build_object(
    'today', v_t, 'from', v_t - v_past, 'to', v_t + v_ahead,
    'gps', coalesce((
      select jsonb_agg(jsonb_build_object('jc_prefix', g.jc_prefix, 'gp_name', g.gp_name, 'report_at', g.report_at,
                                          'older', coalesce(x.older, 0), 'wl', coalesce(x.wl, 0),
                                          'pend_prev', pv.pend, 'prev_at', pv.at) order by g.gp_name)
        from (select distinct on (i.jc_prefix) i.jc_prefix, i.gp_name, i.report_at
                from public.iay_imports i
               where (p_scope is null or i.jc_prefix = p_scope)
                 and exists (select 1 from public.iay_works w where w.jc_prefix = i.jc_prefix)
               order by i.jc_prefix, i.at desc) g
        left join (select w.jc_prefix,
                          count(*) filter (where r.end_date < v_t - v_past
                                             and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')) older,
                          count(*) filter (where r.status = 'Filled') wl
                     from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
                    where p_scope is null or w.jc_prefix = p_scope
                    group by 1) x on x.jc_prefix = g.jc_prefix
        left join lateral (select p.pend, p.at from public.iay_imports p
                            where p.jc_prefix = g.jc_prefix and p.pend is not null
                              and p.at <= now() - interval '55 minutes' and p.at > now() - interval '30 hours'
                            order by p.at desc limit 1) pv on true), '[]'::jsonb),
    'cells', coalesce((
      select jsonb_agg(jsonb_build_object('jc_prefix', x.jc_prefix, 'date', x.d, 'total', x.total, 'filled', x.filled))
        from (select w.jc_prefix, r.end_date d, count(*) total,
                     count(*) filter (where r.status in ('Filled', 'WL Generated')) filled
                from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
               where (p_scope is null or w.jc_prefix = p_scope)
                 and r.end_date between v_t - v_past and v_t + v_ahead
                 and coalesce(r.status, '') <> 'Zero'
               group by 1, 2) x), '[]'::jsonb));
end $$;

select 'OK: pending delta installed' as result;
