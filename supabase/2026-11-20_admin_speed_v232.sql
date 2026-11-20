-- =====================================================================
-- v232 · Admin panel opens faster
--   admin_list_gps() is asked every time the Admin panel opens. It counted workers, active
--   workers and accounts with 3 sub-queries PER GP (7 GPs, 52,000 workers: ~1 second, and it
--   grows with every new GP). Now the counts are made in one pass over each table (~70 ms).
--   Same name, same columns, same answer, same rights — only faster. Nothing else changes.
-- Supabase dashboard → SQL Editor → paste all → Run. Safe to run twice.
-- =====================================================================
begin;

create or replace function public.admin_list_gps()
 returns table(id smallint, name text, jc_prefix text, workers bigint, active_workers bigint, accounts bigint)
 language plpgsql stable security definer set search_path to '' as $function$
#variable_conflict use_column
declare v_scope smallint := private.admin_scope();
begin
  return query
    with w as (
      select x.gp_id, count(*) as n, count(*) filter (where x.active) as n_active
      from public.workers x
      where v_scope is null or x.gp_id = v_scope
      group by x.gp_id
    ), a as (
      select x.gp_id, count(*) as n
      from public.worker_accounts acc join public.workers x on x.id = acc.worker_id
      where v_scope is null or x.gp_id = v_scope
      group by x.gp_id
    )
    select g.id, g.name, g.jc_prefix,
           coalesce(w.n, 0)::bigint, coalesce(w.n_active, 0)::bigint, coalesce(a.n, 0)::bigint
    from public.gram_panchayats g
    left join w on w.gp_id = g.id
    left join a on a.gp_id = g.id
    where g.active and (v_scope is null or g.id = v_scope)
    order by g.id;
end $function$;
revoke all on function public.admin_list_gps() from public, anon;
grant execute on function public.admin_list_gps() to authenticated;

select private.schema_mark(232, 'Admin panel opens faster (GP list counts in one pass)');

commit;

notify pgrst, 'reload schema';
