-- =====================================================================
-- v230 · Rename a Gram Panchayat (Super Admin only)
--   admin_rename_gp(p_gp_id, p_name) — changes the GP's display name only.
--   Job Card prefix, workers, lists and logins are not touched.
-- Supabase dashboard → SQL Editor → paste all → Run. Safe to run twice.
-- =====================================================================
begin;

create or replace function public.admin_rename_gp(p_gp_id smallint, p_name text)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := auth.uid(); v_old text; v_name text := btrim(coalesce(p_name, ''));
begin
  if v_uid is null then raise exception 'NOT_LOGGED_IN' using errcode = '28000'; end if;
  if not private.report_is_admin() or private.admin_scope() is not null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';            -- Super Admin only
  end if;
  if length(v_name) < 2 or length(v_name) > 100 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select name into v_old from public.gram_panchayats where id = p_gp_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update public.gram_panchayats set name = v_name where id = p_gp_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'gp_rename', 'gram_panchayats', p_gp_id::text, jsonb_build_object('old', v_old, 'new', v_name));
  return jsonb_build_object('ok', true, 'id', p_gp_id, 'name', v_name);
end $$;
revoke all on function public.admin_rename_gp(smallint, text) from public, anon;
grant execute on function public.admin_rename_gp(smallint, text) to authenticated;

select private.schema_mark(230, 'Admin: rename a GP');

commit;

notify pgrst, 'reload schema';
