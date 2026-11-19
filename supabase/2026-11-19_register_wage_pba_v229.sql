-- =====================================================================
-- v229 · Work Register + pipeline follow-up
--   • PBA (IAY) works have no e-MB / Verify step: after the MR is filled they
--     go straight to "WL বাকি". So e-MB বাকি and Verify বাকি are always 0 for PBA.
--     (private.mr_stage is used by Admin Pipeline and by the Report pages.)
--   • Wage rate (default ₹300/day) is kept in Admin settings and used on the
--     Report 📒 Register tab: Pending mandays = pending unskilled amount ÷ wage rate.
--       - report_context() now also returns wage_rate
--       - admin_set_wage_rate(p_rate) — Super Admin only
-- Supabase dashboard → SQL Editor → paste all → Run. Safe to run twice.
-- =====================================================================

begin;

-- ---------- PBA skips e-MB / Verify ----------
create or replace function private.mr_stage(r public.pipeline_mrs, p_today date)
returns text language sql stable set search_path to '' as $$
  select case
    when r.zero then 'zero'
    when coalesce(r.wl_no, '') <> '' or coalesce(r.wl_date, '') <> '' then 'wl_done'
    when not r.filled and r.meas_date is null then
      case when r.date_to is null then 'fill_pending' when r.date_to > p_today then 'running'
           when r.date_to = p_today then 'fill_today' else 'fill_pending' end
    when r.work_code ~* '/IAY/' then 'wl_pending'
    when r.meas_date is null then 'emb'
    when r.verif_date is null then 'verify'
    else 'wl_pending' end
$$;

-- ---------- app settings (wage rate) ----------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
insert into public.app_settings (key, value) values ('wage_rate', '300'::jsonb) on conflict (key) do nothing;

create or replace function private.wage_rate()
 returns numeric language sql stable security definer set search_path to '' as $$
  select coalesce((select (s.value #>> '{}')::numeric from public.app_settings s where s.key = 'wage_rate'), 300)
$$;
revoke all on function private.wage_rate() from public, anon, authenticated;

create or replace function public.admin_set_wage_rate(p_rate numeric)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_LOGGED_IN' using errcode = '28000'; end if;
  if not private.report_is_admin() or private.admin_scope() is not null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';            -- Super Admin only
  end if;
  if p_rate is null or p_rate < 1 or p_rate > 5000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  insert into public.app_settings (key, value, updated_at, updated_by) values ('wage_rate', to_jsonb(round(p_rate, 2)), now(), v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, null, 'wage_rate_set', 'app_settings', 'wage_rate', jsonb_build_object('rate', round(p_rate, 2)));
  return jsonb_build_object('ok', true, 'wage_rate', round(p_rate, 2));
end $$;
revoke all on function public.admin_set_wage_rate(numeric) from public, anon;
grant execute on function public.admin_set_wage_rate(numeric) to authenticated;

-- ---------- report_context (v228) + wage_rate ----------
create or replace function public.report_context()
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gps smallint[] := private.report_gps(); v_p public.profiles%rowtype; v_r public.report_viewers%rowtype;
begin
  select * into v_p from public.profiles where user_id = auth.uid();
  select * into v_r from public.report_viewers where user_id = auth.uid();
  return jsonb_build_object(
    'username', v_p.username, 'full_name', v_p.full_name, 'role', v_p.role,
    'designation', v_r.designation, 'block', coalesce(v_r.block, false) or v_p.role = 'super_admin',
    'is_admin', v_p.role in ('super_admin', 'gp_admin'), 'is_super', v_p.role = 'super_admin',
    'today', private.iay_today(), 'wage_rate', private.wage_rate(),
    'gps', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'jc_prefix', g.jc_prefix) order by g.name)
                       from public.gram_panchayats g where g.id = any (v_gps)), '[]'::jsonb));
end $$;

select private.schema_mark(229, 'Register: PBA skips e-MB/Verify, wage rate setting');

commit;

notify pgrst, 'reload schema';
