-- =====================================================================
-- G RAM-G 4A — IAY report extras (v196, 2026-11-09)
--  * MR Summary: per GP "older" = MRs that ended BEFORE the chosen window
--    and are still not filled, and "wl" = MRs filled but wagelist not yet made.
--  * iay_sync_digest(p_key): block counts for the Raspberry Pi's morning
--    message (same key and scope as iay_sync_gp). Counts only.
-- Requires v194. Safe to run again.
-- =====================================================================

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
                                          'older', coalesce(x.older, 0), 'wl', coalesce(x.wl, 0)) order by g.gp_name)
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
                    group by 1) x on x.jc_prefix = g.jc_prefix), '[]'::jsonb),
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

-- Morning message for the Pi (no login; the sync key decides the scope).
create or replace function public.iay_sync_digest(p_key text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare k public.iay_sync_keys%rowtype; p public.profiles%rowtype; v_scope text; v_t date := private.iay_today(); v_out jsonb;
begin
  if p_key is null or p_key !~ '^iay_[0-9a-f]{48}$' then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  select * into k from public.iay_sync_keys where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex') and revoked_at is null;
  if not found then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  select * into p from public.profiles where user_id = k.user_id and active;
  if not found or p.role not in ('super_admin', 'gp_admin') then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  if p.role = 'gp_admin' then
    select g.jc_prefix into v_scope from public.gram_panchayats g where g.id = p.gp_id and g.active;
  end if;
  with m as (
    select w.gp_name, r.end_date, r.status
      from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
     where v_scope is null or w.jc_prefix = v_scope),
  s as (select * from private.iay_state(v_scope)),
  g as (
    select gp_name,
           count(*) filter (where end_date < v_t and coalesce(status, '') not in ('Filled', 'WL Generated', 'Zero')) overdue,
           count(*) filter (where end_date = v_t and coalesce(status, '') not in ('Filled', 'WL Generated', 'Zero')) today,
           count(*) filter (where end_date = v_t + 1) tomorrow,
           count(*) filter (where status = 'Filled') wl
      from m group by 1),
  n as (
    select gp_name, count(*) filter (where next_start <= v_t + 5) next_mr from s group by 1)
  select jsonb_build_object(
    'today', v_t,
    'last_update', (select max(report_at) from public.iay_imports where v_scope is null or jc_prefix = v_scope),
    'oldest_update', (select min(x.r) from (select distinct on (jc_prefix) report_at r from public.iay_imports
                                             where v_scope is null or jc_prefix = v_scope order by jc_prefix, at desc) x),
    'total', jsonb_build_object('overdue', coalesce(sum(g.overdue), 0), 'today', coalesce(sum(g.today), 0),
                                'tomorrow', coalesce(sum(g.tomorrow), 0), 'wl', coalesce(sum(g.wl), 0),
                                'next_mr', coalesce(sum(n.next_mr), 0)),
    'gps', coalesce(jsonb_agg(jsonb_build_object('gp', g.gp_name, 'overdue', g.overdue, 'today', g.today, 'wl', g.wl,
                                                 'next_mr', coalesce(n.next_mr, 0)) order by g.overdue + g.today desc), '[]'::jsonb))
    into v_out
    from g left join n using (gp_name);
  return v_out;
end $$;

revoke all on function public.iay_sync_digest(text) from public;
grant execute on function public.iay_sync_digest(text) to anon, authenticated;

select 'OK: IAY report extras installed' as result;
