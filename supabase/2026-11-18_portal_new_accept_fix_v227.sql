-- =====================================================================
-- v227 · Fix: Accept on "🆕 New on the portal" failed with
--   "cannot insert a non-DEFAULT value into column village_no"
-- In the live database village_no, household_no and household_suffix are
-- GENERATED from the Job Card number, so the Accept must not write them.
-- Only admin_portal_new_decide changes. Nothing else.
-- Supabase dashboard → SQL Editor → paste all → Run.
-- =====================================================================

begin;

-- ---------- Admin: accept / ignore / bring back ----------
-- p_action: 'accept' (add as active workers) | 'ignore' | 'unignore' (back to the New list)
create or replace function public.admin_portal_new_decide(p_gp_id smallint, p_ids bigint[], p_action text)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_n integer := 0; v_skip integer := 0;
begin
  if coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 20000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if p_action = 'accept' then
    -- someone already in Gram Setu (e.g. imported meanwhile): just mark accepted
    update public.portal_new_workers n set status = 'accepted', decided_by = v_uid, decided_at = now(),
           worker_id = (select w.id from public.workers w where w.gp_id = n.gp_id and w.applicant_no = n.applicant_no
                          and private.norm_card(w.job_card_no) = n.job_card_no limit 1)
     where n.gp_id = p_gp_id and n.id = any (p_ids) and n.status = 'new'
       and exists (select 1 from public.workers w where w.gp_id = n.gp_id and w.applicant_no = n.applicant_no
                     and private.norm_card(w.job_card_no) = n.job_card_no);
    get diagnostics v_skip = row_count;

    with ins as (
      -- village_no / household_no / household_suffix / eligible are GENERATED columns: the database fills them
      insert into public.workers (gp_id, job_card_no, applicant_no, applicant_name, aadhaar_seeded, authentication_done, abps, ekyc, active)
      select n.gp_id, n.job_card_no, n.applicant_no, n.applicant_name, n.aadhaar_seeded, n.authentication_done, n.abps, n.ekyc, true
        from public.portal_new_workers n
       where n.gp_id = p_gp_id and n.id = any (p_ids) and n.status = 'new'
      on conflict (gp_id, job_card_no, applicant_no) do nothing
      returning id, job_card_no, applicant_no)
    update public.portal_new_workers n set status = 'accepted', worker_id = ins.id, decided_by = v_uid, decided_at = now()
      from ins
     where n.gp_id = p_gp_id and n.job_card_no = ins.job_card_no and n.applicant_no = ins.applicant_no;
    get diagnostics v_n = row_count;
  elsif p_action = 'ignore' then
    update public.portal_new_workers set status = 'ignored', decided_by = v_uid, decided_at = now()
     where gp_id = p_gp_id and id = any (p_ids) and status = 'new';
    get diagnostics v_n = row_count;
  elsif p_action = 'unignore' then
    update public.portal_new_workers set status = 'new', decided_by = null, decided_at = null
     where gp_id = p_gp_id and id = any (p_ids) and status = 'ignored';
    get diagnostics v_n = row_count;
  else
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  insert into public.audit_logs (actor_id, gp_id, action, entity, details)
  values (v_uid, p_gp_id, 'portal_new_' || p_action, 'workers', jsonb_build_object('n', v_n, 'already_in', v_skip, 'asked', cardinality(p_ids)));
  return jsonb_build_object('changed', v_n, 'already_in', v_skip);
end $$;
revoke all on function public.admin_portal_new_decide(smallint, bigint[], text) from public, anon;
grant execute on function public.admin_portal_new_decide(smallint, bigint[], text) to authenticated;

select private.schema_mark(227, 'Fix Accept of new portal workers (generated village/household columns)');

commit;

notify pgrst, 'reload schema';
