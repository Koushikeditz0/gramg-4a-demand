-- =====================================================================
-- G RAM-G 4A List Builder — Account copy, part 3 (2026-11-01)
-- Needs v180 + v181 first.
--   * Account holder name (as written in the passbook) with the photo
--   * Supervisor can send the account of ANY worker of their GP
--     ("➕ অন্য কারো account পাঠান"), found by name or Job Card
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

alter table public.account_photos add column if not exists holder_name text;

drop function if exists public.add_account_photo(bigint, uuid, text, integer, text, text);
create or replace function public.add_account_photo(p_worker_id bigint, p_list_id uuid, p_path text, p_size integer,
                                                    p_account_no text default null, p_ifsc text default null,
                                                    p_holder_name text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_old text[]; v_id uuid;
        v_acc text := nullif(regexp_replace(coalesce(p_account_no, ''), '\s+', '', 'g'), '');
        v_ifsc text := nullif(upper(regexp_replace(coalesce(p_ifsc, ''), '\s+', '', 'g')), '');
        v_holder text := nullif(left(upper(regexp_replace(trim(coalesce(p_holder_name, '')), '\s+', ' ', 'g')), 100), '');
begin
  if not exists (select 1 from public.workers w where w.id = p_worker_id and w.gp_id = v_gp) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if v_acc is not null and v_acc !~ '^[0-9]{6,20}$' then raise exception 'BAD_ACCOUNT_NO' using errcode = '22023'; end if;
  if v_ifsc is not null and v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then raise exception 'BAD_IFSC' using errcode = '22023'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> v_gp::text or split_part(p_path, '/', 2) <> auth.uid()::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'account-copies' and o.name = p_path) then
    raise exception 'PHOTO_NOT_FOUND' using errcode = '22023';
  end if;
  if p_list_id is not null and not exists (select 1 from public.demand_lists l where l.id = p_list_id and l.gp_id = v_gp) then
    p_list_id := null;
  end if;
  with r as (
    update public.account_photos set status = 'replaced'
     where worker_id = p_worker_id and gp_id = v_gp and status = 'new' and purged_at is null
    returning path)
  select coalesce(array_agg(path), '{}') into v_old from r;
  insert into public.account_photos (gp_id, worker_id, list_id, path, size_bytes, uploaded_by, account_no, ifsc, holder_name)
  values (v_gp, p_worker_id, p_list_id, p_path, p_size, auth.uid(), v_acc, v_ifsc, v_holder)
  on conflict (path) do nothing
  returning id into v_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_gp, 'account_photo_add', 'workers', p_worker_id::text,
          jsonb_build_object('path', p_path, 'size', p_size, 'account_no', v_acc, 'ifsc', v_ifsc, 'holder', v_holder));
  return jsonb_build_object('id', v_id, 'old_paths', to_jsonb(v_old));
end $$;
revoke all on function public.add_account_photo(bigint, uuid, text, integer, text, text, text) from public, anon;
grant execute on function public.add_account_photo(bigint, uuid, text, integer, text, text, text) to authenticated;

-- Supervisor: find any worker of my GP by name or Job Card (e.g. "16/98", "016/098", full number)
create or replace function public.search_account_worker(p_query text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_q text := trim(coalesce(p_query, '')); v_v int; v_h int; v_m text[];
begin
  if length(v_q) < 2 then raise exception 'QUERY_TOO_SHORT' using errcode = '22023'; end if;
  v_m := regexp_match(v_q, '(\d{1,3})\s*/\s*(\d{1,4})\s*$');
  if v_m is not null then v_v := v_m[1]::int; v_h := v_m[2]::int; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'worker_id', x.id, 'job_card_no', x.job_card_no, 'applicant_no', x.applicant_no, 'applicant_name', x.applicant_name,
      'village_no', x.village_no, 'household_no', x.household_no) order by x.village_no, x.household_no, x.applicant_no)
    from (select w.* from public.workers w
           where w.gp_id = v_gp and w.active
             and (case when v_v is not null then w.village_no = v_v and w.household_no = v_h
                       else lower(w.applicant_name) like '%' || lower(replace(replace(v_q, '%', ''), '_', '')) || '%' end)
           order by w.village_no, w.household_no, w.applicant_no limit 40) x), '[]'::jsonb);
end $$;
revoke all on function public.search_account_worker(text) from public, anon;
grant execute on function public.search_account_worker(text) to authenticated;

-- Admin list: + holder name
create or replace function public.admin_account_photos(p_gp_id smallint, p_status text default 'new')
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_scope smallint := private.admin_scope();
begin
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'path', a.path, 'status', a.status, 'size', a.size_bytes,
        'uploaded_at', a.uploaded_at, 'done_at', a.done_at, 'return_reason', a.return_reason,
        'sent_account_no', a.account_no, 'sent_ifsc', a.ifsc, 'holder_name', a.holder_name,
        'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
        'village_no', w.village_no, 'account_no', wa.account_no, 'ifsc', wa.ifsc,
        'requested', exists (select 1 from public.account_requests q where q.worker_id = a.worker_id and q.status <> 'closed'),
        'work_name', l.work_name, 'uploaded_by', coalesce(nullif(p.full_name, ''), p.username))
        order by a.uploaded_at desc)
      from public.account_photos a
      join public.workers w on w.id = a.worker_id
      left join public.worker_accounts wa on wa.worker_id = a.worker_id
      left join public.demand_lists l on l.id = a.list_id
      left join public.profiles p on p.user_id = a.uploaded_by
      where a.gp_id = p_gp_id
        and ((a.status = 'new' and a.purged_at is null and coalesce(p_status, 'new') in ('new', 'all'))
          or (a.status in ('done', 'returned') and a.done_at > now() - interval '30 days' and p_status in ('done', 'all')))), '[]'::jsonb),
    'new_count', (select count(*) from public.account_photos a where a.gp_id = p_gp_id and a.status = 'new' and a.purged_at is null),
    'stored_bytes', (select coalesce(sum(a.size_bytes), 0) from public.account_photos a
                      where a.purged_at is null and (v_scope is null or a.gp_id = p_gp_id)),
    'all_gps', v_scope is null);
end $$;

select 'OK: Account copy part 3 (holder name, search any worker) installed' as result;
