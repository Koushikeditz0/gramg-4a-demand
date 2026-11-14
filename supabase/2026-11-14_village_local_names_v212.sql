-- =====================================================================
-- Gram Setu — local village names (v212, 2026-11-14)
--
-- The Admin / GP Admin writes a local name (Bangla or common name) for each
-- village number of a GP in Admin → "🏗 Works & Supervisors" → "🏘 Village names".
-- The phone app then shows "002 · <local name>" wherever a village appears.
-- A village with no local name keeps showing its number as before.
--
--   get_village_names()                       → [{"v": 2, "name": "..."}]   (phone app, own GP)
--   admin_get_village_names(p_gp_id)          → [{"v", "name", "workers", "families"}]
--   admin_save_village_names(p_gp_id, p_rows) → {"saved": n, "cleared": n}
--       p_rows = [{"v": 2, "name": "Kalibari"}]; a blank name removes the local name.
--
-- New table + new functions only, nothing existing changes.
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create table if not exists public.village_names (
  gp_id smallint not null references public.gram_panchayats(id),
  village_no int not null check (village_no between 0 and 9999),
  local_name text not null check (char_length(local_name) between 1 and 60),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (gp_id, village_no)
);
alter table public.village_names enable row level security;
revoke all on public.village_names from anon, authenticated;

-- ---------- phone app ----------
create or replace function public.get_village_names()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('v', n.village_no, 'name', n.local_name) order by n.village_no)
                     from public.village_names n where n.gp_id = v_gp), '[]'::jsonb);
end $$;

-- ---------- Admin / GP Admin ----------
create or replace function public.admin_get_village_names(p_gp_id smallint)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform private.require_admin_gp(p_gp_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object('v', x.v, 'name', n.local_name, 'workers', coalesce(x.workers, 0), 'families', coalesce(x.families, 0))
                     order by x.v)
      from (select coalesce(w.v, n2.village_no) as v, w.workers, w.families
              from (select w.village_no as v, count(*) as workers, count(distinct w.household_no) as families
                      from public.workers w where w.gp_id = p_gp_id and w.active
                     group by w.village_no) w
              full join (select village_no from public.village_names where gp_id = p_gp_id) n2 on n2.village_no = w.v) x
      left join public.village_names n on n.gp_id = p_gp_id and n.village_no = x.v), '[]'::jsonb);
end $$;

create or replace function public.admin_save_village_names(p_gp_id smallint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); r jsonb; v_no int; v_name text;
        v_saved int := 0; v_cleared int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'v', '') !~ '^[0-9]{1,4}$' then continue; end if;
    v_no := (r->>'v')::int;
    v_name := left(btrim(regexp_replace(coalesce(r->>'name', ''), '\s+', ' ', 'g')), 60);
    if v_name = '' then
      delete from public.village_names where gp_id = p_gp_id and village_no = v_no;
      if found then v_cleared := v_cleared + 1; end if;
    else
      insert into public.village_names (gp_id, village_no, local_name, updated_by, updated_at)
      values (p_gp_id, v_no, v_name, v_uid, now())
      on conflict (gp_id, village_no) do update set local_name = excluded.local_name, updated_by = excluded.updated_by, updated_at = now();
      v_saved := v_saved + 1;
    end if;
  end loop;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, p_gp_id, 'village_names_saved', 'village_names', p_gp_id::text, jsonb_build_object('saved', v_saved, 'cleared', v_cleared));
  return jsonb_build_object('saved', v_saved, 'cleared', v_cleared);
end $$;

revoke all on function public.get_village_names() from public, anon;
revoke all on function public.admin_get_village_names(smallint) from public, anon;
revoke all on function public.admin_save_village_names(smallint, jsonb) from public, anon;
grant execute on function public.get_village_names() to authenticated;
grant execute on function public.admin_get_village_names(smallint) to authenticated;
grant execute on function public.admin_save_village_names(smallint, jsonb) to authenticated;
