-- =====================================================================
-- Gram Setu — Payment pipeline: MR fill pending for ALL works (v220, 2026-11-16)
--
-- K-Desk v1.22.0 also reads the Work list of the portal's MR Attendance
-- (MustRollAttend.aspx) and MR Payment (MsrPayment.aspx) pages = works whose
-- MR attendance / payment is still to be filled, and saves it here as two
-- more pipeline_snaps kinds: 'mr_att' and 'mr_pay' (work code + name only).
-- admin_pipeline already returns every snapshot, so it does not change.
-- Needs v217. Safe to run again.
-- =====================================================================

alter table public.pipeline_snaps drop constraint if exists pipeline_snaps_kind_check;
alter table public.pipeline_snaps add constraint pipeline_snaps_kind_check
  check (kind in ('wl_gen', 'send_pay', 'mr_att', 'mr_pay'));

create or replace function public.kdesk_pipeline_snap(p_kind text, p_scope text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_uid uuid := auth.uid(); v_items jsonb; v_old jsonb; v_n int; v_amt numeric;
        v_scope text := left(coalesce(nullif(trim(p_scope), ''), ''), 60);
begin
  if p_kind not in ('wl_gen', 'send_pay', 'mr_att', 'mr_pay') or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 3000 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_kind in ('wl_gen', 'mr_att', 'mr_pay') then
    select coalesce(jsonb_agg(jsonb_build_object('code', upper(x->>'code'), 'name', left(coalesce(x->>'name', ''), 160),
                                                 'held', greatest(coalesce((x->>'held')::int, 0), 0)) order by x->>'code'), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(p_items) x
     where coalesce(x->>'code', '') ~ '^[0-9]{10}/[A-Za-z0-9/._-]{2,60}$';
    v_amt := 0;
  else
    select items into v_old from public.pipeline_snaps where gp_id = v_gp and kind = p_kind and scope = v_scope;
    select coalesce(jsonb_agg(jsonb_build_object('wl', upper(x->>'wl'),
             'amt', coalesce(nullif(x->>'amt', '')::numeric,
                             (select nullif(o->>'amt', '')::numeric from jsonb_array_elements(coalesce(v_old, '[]'::jsonb)) o
                               where upper(o->>'wl') = upper(x->>'wl') limit 1))) order by x->>'wl'), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(p_items) x
     where coalesce(x->>'wl', '') ~* '^[0-9A-Z]{0,20}WL[0-9]{1,12}$';
    select coalesce(sum(nullif(x->>'amt', '')::numeric), 0) into v_amt from jsonb_array_elements(v_items) x;
  end if;
  v_n := jsonb_array_length(v_items);
  insert into public.pipeline_snaps as t (gp_id, kind, scope, items, n, amount, seen_at, seen_by)
  values (v_gp, p_kind, v_scope, v_items, v_n, v_amt, now(), v_uid)
  on conflict (gp_id, kind, scope) do update
    set items = excluded.items, n = excluded.n, amount = excluded.amount, seen_at = now(), seen_by = excluded.seen_by;
  return jsonb_build_object('n', v_n);
end $$;

revoke all on function public.kdesk_pipeline_snap(text, text, jsonb) from public, anon;
grant execute on function public.kdesk_pipeline_snap(text, text, jsonb) to authenticated;

select 'OK: Payment pipeline MR fill pending for all works (v220) installed' as result;
