-- =====================================================================
-- G RAM-G 4A List Builder — K-Desk "Mate + Work sync" (v188, 2026-11-07)
--
-- K-Desk reads two portal pages and fills the GP's Works & Supervisors lists
-- (gp_works / gp_supervisors from v185) with the GP's "kdesk" login:
--
--   matemapping.aspx  → mate dropdown "S-WB-08-005-014-011/1259172#NAME"
--                       → supervisor  Name + ID  S-WB-08-005-014-011/1259172
--                         (the part before "/" is the mate's village job card
--                          prefix, shared by several mates, so the whole ID is kept)
--   Est_Expwork.aspx  → "Work name (3208005014/DP/VB/3210…)", status, year
--                       → work  Name + Work Code
--
--   kdesk_save_masters(p_works, p_sups)
--     p_works = [{name, code, status, year}]   p_sups = [{name, id}]
--     Work: same Work Code = update its name; else same name = add the code;
--           else new. A name already used by another code gets " #<last 6>".
--     Supervisor: same ID = update the name, else new. Supervisors the Admin
--           typed earlier (S-…-07) stay; the Admin can delete them.
--     Only this GP's codes / IDs are taken (others come back in "bad").
--     Nothing is deleted.
--
-- Needs v185 (gp_works, gp_supervisors). Run once in Supabase → SQL Editor.
-- Safe to run again.
-- =====================================================================

create or replace function public.kdesk_save_masters(p_works jsonb default '[]', p_sups jsonb default '[]')
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_uid uuid := auth.uid(); v_pre text; v_digits text;
        r jsonb; v_name text; v_code text; v_sid text; v_id bigint; v_other bigint;
        w_add int := 0; w_upd int := 0; w_same int := 0; s_add int := 0; s_upd int := 0; s_same int := 0;
        v_bad jsonb := '[]'; v_old text;
begin
  p_works := coalesce(p_works, '[]'); p_sups := coalesce(p_sups, '[]');
  if jsonb_typeof(p_works) <> 'array' or jsonb_typeof(p_sups) <> 'array'
     or jsonb_array_length(p_works) > 3000 or jsonb_array_length(p_sups) > 500 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  select jc_prefix into v_pre from public.gram_panchayats where id = v_gp;
  v_digits := regexp_replace(coalesce(v_pre, ''), '\D', '', 'g');          -- WB-08-005-014 → 08005014
  perform pg_advisory_xact_lock(hashtextextended('masters:' || v_gp, 0));

  -- ---------- works ----------
  for r in select * from jsonb_array_elements(p_works) loop
    v_name := left(btrim(regexp_replace(coalesce(r->>'name', ''), '\s+', ' ', 'g')), 180);
    v_code := upper(regexp_replace(coalesce(r->>'code', ''), '\s+', '', 'g'));
    if v_name = '' or v_code = '' then continue; end if;
    if char_length(v_code) > 100 or v_code !~ '^[0-9]{8,12}/[A-Z]{2,3}/[A-Z0-9/]+$'
       or right(split_part(v_code, '/', 1), 8) <> v_digits then
      v_bad := v_bad || jsonb_build_object('name', v_name, 'code', v_code); continue;
    end if;
    v_id := null; v_other := null;
    select id, work_name into v_id, v_old from public.gp_works where gp_id = v_gp and upper(work_code) = v_code limit 1;
    if v_id is null then   -- same name typed earlier by the Admin without a code
      select id into v_id from public.gp_works where gp_id = v_gp and lower(work_name) = lower(v_name) and coalesce(work_code, '') = '' limit 1;
    end if;
    -- the name is taken by a different work → make it unique with the code's tail
    select id into v_other from public.gp_works where gp_id = v_gp and lower(work_name) = lower(v_name) and id is distinct from v_id limit 1;
    if v_other is not null then v_name := v_name || ' #' || right(v_code, 6); end if;
    if v_id is null then
      insert into public.gp_works (gp_id, work_name, work_code, created_by) values (v_gp, v_name, v_code, v_uid)
      on conflict do nothing;
      if found then w_add := w_add + 1; else v_bad := v_bad || jsonb_build_object('name', v_name, 'code', v_code); end if;
    else
      update public.gp_works set work_name = v_name, work_code = v_code, active = true, updated_at = now()
       where id = v_id and (work_name <> v_name or coalesce(work_code, '') <> v_code or not active);
      if found then w_upd := w_upd + 1; else w_same := w_same + 1; end if;
    end if;
  end loop;

  -- ---------- supervisors (mates) ----------
  for r in select * from jsonb_array_elements(p_sups) loop
    v_name := left(btrim(regexp_replace(regexp_replace(coalesce(r->>'name', ''), '[()#]', ' ', 'g'), '\s+', ' ', 'g')), 60);
    v_sid := upper(regexp_replace(coalesce(r->>'id', ''), '\s+', '', 'g'));
    if v_name = '' or v_sid = '' then continue; end if;
    if v_sid not like upper('S-' || v_pre || '-%') or v_sid !~ '^S-[A-Z]{2}(-[0-9]{2,3}){4}/[0-9]{1,12}$' or char_length(v_sid) > 40 then
      v_bad := v_bad || jsonb_build_object('name', v_name, 'id', v_sid); continue;
    end if;
    v_id := null;
    select id into v_id from public.gp_supervisors where gp_id = v_gp and upper(sup_id) = v_sid;
    if v_id is null then
      insert into public.gp_supervisors (gp_id, name, sup_id, created_by) values (v_gp, v_name, v_sid, v_uid);
      s_add := s_add + 1;
    else
      update public.gp_supervisors set name = v_name, active = true, updated_at = now()
       where id = v_id and (name <> v_name or not active);
      if found then s_upd := s_upd + 1; else s_same := s_same + 1; end if;
    end if;
  end loop;

  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'kdesk_masters_sync', 'gp_works', v_gp::text,
          jsonb_build_object('works_added', w_add, 'works_updated', w_upd, 'sups_added', s_add, 'sups_updated', s_upd,
                             'bad', jsonb_array_length(v_bad)));
  return jsonb_build_object('works', jsonb_build_object('added', w_add, 'updated', w_upd, 'same', w_same),
                            'sups', jsonb_build_object('added', s_add, 'updated', s_upd, 'same', s_same),
                            'bad', v_bad);
end $$;

revoke all on function public.kdesk_save_masters(jsonb, jsonb) from public, anon;
grant execute on function public.kdesk_save_masters(jsonb, jsonb) to authenticated;
