-- =====================================================================
-- G RAM-G 4A — IAY import keeps known names (v195, 2026-11-09)
-- When a sender (the Raspberry Pi sync) has no beneficiary name / village /
-- Reg No. / Job Card for a work, the value already saved is kept.
-- Requires v192. Safe to run again.
-- =====================================================================

create or replace function private.iay_import_core(p_jc_prefix text, p_gp_name text, p_report_at timestamptz,
                                                  p_file_name text, p_works jsonb, p_mrs jsonb, p_force boolean, p_actor uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_last timestamptz; v_bad int; v_w int; v_m int; v_old jsonb;
begin
  if p_jc_prefix is null or p_jc_prefix !~ '^WB-[0-9]{2}-[0-9]{3}-[0-9]{3}$' then raise exception 'BAD_GP'; end if;
  if jsonb_typeof(p_works) <> 'array' or jsonb_array_length(p_works) = 0 then raise exception 'NO_WORKS'; end if;
  if jsonb_array_length(p_works) > 20000 or jsonb_array_length(coalesce(p_mrs, '[]'::jsonb)) > 60000 then raise exception 'TOO_MANY_ROWS'; end if;

  select count(*) into v_bad from jsonb_array_elements(p_works) x
   where coalesce(x->>'work_code', '') = '' or not private.iay_row_in_gp(p_jc_prefix, x->>'work_code', x->>'jcn');
  if v_bad > 0 then raise exception 'WRONG_GP_ROWS' using detail = v_bad || ' rows'; end if;

  select max(report_at) into v_last from public.iay_imports where jc_prefix = p_jc_prefix;
  if not coalesce(p_force, false) and v_last is not null and p_report_at is not null and p_report_at < v_last then
    raise exception 'OLDER_REPORT';
  end if;

  -- keep names / village / Reg No. when a sender (e.g. the Pi) does not have them
  select coalesce(jsonb_object_agg(work_code, jsonb_build_object('b', ben_name, 'v', village, 'r', reg_no, 'j', jcn)), '{}'::jsonb)
    into v_old from public.iay_works where jc_prefix = p_jc_prefix;

  delete from public.iay_works where jc_prefix = p_jc_prefix;

  insert into public.iay_works (work_code, jc_prefix, gp_name, reg_no, ben_name, jcn, village, work_status,
                                mandays, wl_info, wl_no, wl_date, report_at)
  select distinct on (x->>'work_code')
         left(x->>'work_code', 60), p_jc_prefix, left(p_gp_name, 100),
         left(coalesce(nullif(x->>'reg_no', ''), v_old->(x->>'work_code')->>'r'), 60),
         left(coalesce(nullif(x->>'ben_name', ''), v_old->(x->>'work_code')->>'b'), 300),
         left(coalesce(nullif(x->>'jcn', ''), v_old->(x->>'work_code')->>'j'), 60),
         left(coalesce(nullif(x->>'village', ''), v_old->(x->>'work_code')->>'v'), 150),
         left(nullif(x->>'work_status', ''), 40),
         case when x->>'mandays' ~ '^[0-9]{1,4}$' then (x->>'mandays')::int end,
         left(nullif(x->>'wl_info', ''), 40), left(nullif(x->>'wl_no', ''), 500),
         case when x->>'wl_date' ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'wl_date')::date end,
         p_report_at
    from jsonb_array_elements(p_works) x
   where char_length(x->>'work_code') >= 5
   order by x->>'work_code';
  get diagnostics v_w = row_count;

  insert into public.iay_mrs (work_code, mr_no, seq, start_date, end_date, status)
  select distinct on (x->>'work_code', (x->>'mr_no')::bigint)
         x->>'work_code', (x->>'mr_no')::bigint,
         case when x->>'seq' ~ '^[0-9]{1,3}$' then (x->>'seq')::smallint end,
         (x->>'start_date')::date, (x->>'end_date')::date, left(nullif(x->>'status', ''), 30)
    from jsonb_array_elements(coalesce(p_mrs, '[]'::jsonb)) x
    join public.iay_works w on w.work_code = x->>'work_code'
   where x->>'mr_no' ~ '^[0-9]{1,15}$'
     and x->>'start_date' ~ '^\d{4}-\d{2}-\d{2}$' and x->>'end_date' ~ '^\d{4}-\d{2}-\d{2}$'
   order by x->>'work_code', (x->>'mr_no')::bigint;
  get diagnostics v_m = row_count;

  insert into public.iay_imports (jc_prefix, gp_name, works, mrs, report_at, file_name, imported_by)
  values (p_jc_prefix, left(p_gp_name, 100), v_w, v_m, p_report_at, left(p_file_name, 200), p_actor);

  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (p_actor, (select id from public.gram_panchayats where jc_prefix = p_jc_prefix), 'iay_import', 'iay', p_jc_prefix,
          jsonb_build_object('gp', p_gp_name, 'works', v_w, 'mrs', v_m, 'report_at', p_report_at, 'source', left(p_file_name, 60)));

  return jsonb_build_object('works', v_w, 'mrs', v_m);
end $$;

select 'OK: IAY import keeps names' as result;
