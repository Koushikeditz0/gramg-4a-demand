-- =====================================================================
-- v231 · Rename a user (full name) from Admin → Users
--   admin_rename_user(p_user_id, p_name) — changes only the display name (profiles.full_name).
--   Super Admin: anyone (including themself). GP Admin: only supervisors / K-Desk logins / viewers of their own GP.
-- Supabase dashboard → SQL Editor → paste all → Run. Safe to run twice.
-- =====================================================================
begin;

create or replace function public.admin_rename_user(p_user_id uuid, p_name text)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := auth.uid(); v_p public.profiles%rowtype; v_name text := btrim(coalesce(p_name, ''));
begin
  if v_uid is null then raise exception 'NOT_LOGGED_IN' using errcode = '28000'; end if;
  if not private.report_is_admin() then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into v_p from public.profiles where user_id = p_user_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if private.admin_scope() is not null then                         -- GP Admin: own GP's non-admin users only
    if v_p.role not in ('gp_user', 'kdesk', 'viewer') or v_p.gp_id is distinct from private.admin_scope() then
      raise exception 'NOT_AUTHORIZED' using errcode = '42501';
    end if;
  end if;
  if length(v_name) < 2 or length(v_name) > 100 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update public.profiles set full_name = v_name where user_id = p_user_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_p.gp_id, 'user_rename', 'profiles', p_user_id::text, jsonb_build_object('old', v_p.full_name, 'new', v_name));
  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'full_name', v_name);
end $$;
revoke all on function public.admin_rename_user(uuid, text) from public, anon;
grant execute on function public.admin_rename_user(uuid, text) to authenticated;

select private.schema_mark(231, 'Admin: rename a user');

commit;

notify pgrst, 'reload schema';
