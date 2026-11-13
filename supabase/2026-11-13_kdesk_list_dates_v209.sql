-- =====================================================================
-- Gram Setu — K-Desk gets the supervisor's work date (v209, 2026-11-13)
--
-- Bug: the supervisor picks From date + Working days on the ③ page (v189),
-- but kdesk_lists / kdesk_list_rows never sent them, so K-Desk's
-- "☁ Gram Setu" loader used its own "Work From" box (today by default)
-- and the Demand went to the portal with today's date.
--
-- Fix: both functions now also return from_date + work_days of each list.
-- K-Desk v1.17.1+ uses them per worker; lists without a date still use
-- the K-Desk box. Same signatures, so grants stay as they are.
--
-- Needs v189 (demand_lists.from_date, work_days). Run once in
-- Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create or replace function public.kdesk_lists()
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_gp smallint := private.require_kdesk(); v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'list_id', l.id, 'username', p.username, 'full_name', p.full_name, 'work_name', l.work_name,
           'work_code', l.work_code, 'from_date', l.from_date, 'work_days', l.work_days,
           'supervisors', to_jsonb(l.supervisors), 'submit_state', l.submit_state,
           'submitted_at', l.submitted_at, 'locked_at', l.locked_at,
           'exported_at', l.exported_at, 'export_count', l.export_count,
           'workers', (select count(*) from public.demand_list_items i where i.list_id = l.id),
           'eligible', (select count(*) from public.demand_list_items i join public.workers w on w.id = i.worker_id
                         where i.list_id = l.id and w.eligible and w.active))
         order by l.submitted_at desc nulls last, l.work_name), '[]'::jsonb)
    into v
  from public.demand_lists l join public.profiles p on p.user_id = l.owner_id
  where l.gp_id = v_gp and l.status = 'active' and l.submit_state in ('submitted', 'locked');
  return v;
end $function$;

create or replace function public.kdesk_list_rows(p_list_ids uuid[])
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_gp smallint := private.require_kdesk(); v_n integer; v jsonb;
begin
  if coalesce(cardinality(p_list_ids), 0) = 0 or cardinality(p_list_ids) > 200 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  select count(*) into v_n from public.demand_lists l
   where l.id = any(p_list_ids) and l.gp_id = v_gp and l.status = 'active' and l.submit_state in ('submitted', 'locked');
  if v_n <> (select count(distinct x) from unnest(p_list_ids) x) then
    raise exception 'LIST_NOT_FOUND' using errcode = '42501';
  end if;
  update public.demand_lists l set exported_at = now(), export_count = l.export_count + 1
   where l.id = any(p_list_ids);
  insert into public.audit_logs (actor_id, gp_id, action, entity, details)
  values (auth.uid(), v_gp, 'lists_loaded_kdesk', 'demand_lists', jsonb_build_object('lists', to_jsonb(p_list_ids)));
  select coalesce(jsonb_agg(jsonb_build_object(
           'list_id', l.id, 'username', p.username, 'work_name', l.work_name, 'work_code', l.work_code, 'worker_id', w.id,
           'from_date', l.from_date, 'work_days', l.work_days,
           'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
           'village_no', w.village_no, 'household_no', w.household_no, 'eligible', w.eligible,
           'ekyc', w.ekyc, 'abps', w.abps, 'worker_active', w.active)
         order by w.village_no, w.household_no, w.job_card_no, w.applicant_no, p.username), '[]'::jsonb)
    into v
  from public.demand_lists l
  join public.profiles p on p.user_id = l.owner_id
  join public.demand_list_items i on i.list_id = l.id
  join public.workers w on w.id = i.worker_id
  where l.id = any(p_list_ids);
  return v;
end $function$;

select 'OK: K-Desk now gets list dates (v209)' as result;
