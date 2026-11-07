-- =====================================================================
-- G RAM-G 4A List Builder — Account copy requests from K-Desk (v184, 2026-11-07)
-- Needs 2026-10-31_account_requests.sql (v181) first.
--
-- On the portal's Wage List page K-Desk reads the workers whose bank
-- account is not frozen and sends them here with the GP's "kdesk" login.
-- They become the same "📷 Account copy চাই" requests the Admin panel makes
-- (sent to every supervisor of that GP). Only the kdesk login's own GP.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

-- p_rows = [{"jc": "...", "ap": 1, "name": "..."}, ...]
-- Matching: job card + Applicant No (the Wage List page shows it); without "ap",
-- or when that applicant is not in the app, the same name matching as admin_add_account_requests.
create or replace function public.kdesk_add_account_requests(p_rows jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_uid uuid := auth.uid();
        r jsonb; v_jc text; v_name text; v_w bigint; v_n int; v_cnt int;
        v_added int := 0; v_already int := 0; v_missing jsonb := '[]'; v_unclear jsonb := '[]';
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_jc := private.norm_card(r->>'jc'); v_name := lower(regexp_replace(coalesce(r->>'name', ''), '[^A-Za-z]+', '', 'g'));
    if v_jc = '' then continue; end if;
    select count(*) into v_cnt from public.workers w where w.gp_id = v_gp and private.norm_card(w.job_card_no) = v_jc;
    if v_cnt = 0 then v_missing := v_missing || jsonb_build_object('jc', r->>'jc', 'name', r->>'name'); continue; end if;
    v_w := null;
    if coalesce(r->>'ap', '') ~ '^[0-9]{1,4}$' then
      select w.id into v_w from public.workers w
       where w.gp_id = v_gp and private.norm_card(w.job_card_no) = v_jc and w.applicant_no = (r->>'ap')::int;
    end if;
    if v_w is not null then null;
    elsif v_name <> '' then
      select w.id into v_w from public.workers w
       where w.gp_id = v_gp and private.norm_card(w.job_card_no) = v_jc
         and extensions.similarity(lower(regexp_replace(w.applicant_name, '[^A-Za-z]+', '', 'g')), v_name) >= 0.35
       order by extensions.similarity(lower(regexp_replace(w.applicant_name, '[^A-Za-z]+', '', 'g')), v_name) desc, w.applicant_no
       limit 1;
    elsif v_cnt = 1 then
      select w.id into v_w from public.workers w where w.gp_id = v_gp and private.norm_card(w.job_card_no) = v_jc;
    end if;
    if v_w is null then v_unclear := v_unclear || jsonb_build_object('jc', r->>'jc', 'name', r->>'name'); continue; end if;
    insert into public.account_requests (gp_id, worker_id, assigned_to, note, created_by)
    values (v_gp, v_w, null, nullif(left(trim(coalesce(p_note, '')), 200), ''), v_uid)
    on conflict (worker_id) where status <> 'closed' do nothing;
    get diagnostics v_n = row_count;
    if v_n = 1 then v_added := v_added + 1; else v_already := v_already + 1; end if;
  end loop;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'account_request_add_kdesk', 'account_requests', null, jsonb_build_object('added', v_added, 'already', v_already));
  return jsonb_build_object('added', v_added, 'already', v_already, 'not_found', v_missing, 'unclear', v_unclear);
end $$;

revoke all on function public.kdesk_add_account_requests(jsonb, text) from public, anon;
grant execute on function public.kdesk_add_account_requests(jsonb, text) to authenticated;
