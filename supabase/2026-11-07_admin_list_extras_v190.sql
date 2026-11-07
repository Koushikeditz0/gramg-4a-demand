-- =====================================================================
-- G RAM-G 4A List Builder — Admin panel: list dates + missing accounts (v190, 2026-11-07)
--
--   admin_list_extras(p_gp_id) → [{list_id, from_date, work_days, no_account}]
--     from_date / work_days : what the supervisor gave on ③ (SQL v189)
--     no_account            : workers of the list without Account No or IFSC
--   The Admin panel shows them on each list card and the K-Desk export uses
--   each list's own From + Working Day.
--
-- Read-only. Needs v189 (demand_lists.from_date, work_days).
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create or replace function public.admin_list_extras(p_gp_id smallint)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform private.require_admin_gp(p_gp_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'list_id', l.id, 'from_date', l.from_date, 'work_days', l.work_days,
             'no_account', (select count(*) from public.demand_list_items i
                              left join public.worker_accounts a on a.worker_id = i.worker_id
                             where i.list_id = l.id
                               and (coalesce(a.account_no, '') = '' or coalesce(a.ifsc, '') = ''))))
      from public.demand_lists l
     where l.gp_id = p_gp_id and l.status = 'active'), '[]'::jsonb);
end $$;

revoke all on function public.admin_list_extras(smallint) from public, anon;
grant execute on function public.admin_list_extras(smallint) to authenticated;

select 'OK: admin list extras installed' as result;
