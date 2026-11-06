-- =====================================================================
-- G RAM-G 4A List Builder — Account copy photos on Cloudflare R2 (v183)
-- Needs v180, v181, v182 first.
--   * account_photo_access(): the Cloudflare Worker asks this, with the
--     user's own login token, whether a photo may be uploaded / opened /
--     deleted (same rule as the Supabase bucket).
--   * Photos whose file name starts with "r2" are kept in R2; older photos
--     stay in the Supabase bucket and keep working.
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

create or replace function public.account_photo_access(p_path text, p_mode text)
returns boolean language sql stable security definer set search_path to '' as $$
  select p_mode in ('insert', 'read') and private.photo_access(p_path, p_mode)
$$;
revoke all on function public.account_photo_access(text, text) from public, anon;
grant execute on function public.account_photo_access(text, text) to authenticated;

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
  -- files named r2... live in Cloudflare R2 (the Worker checked the upload); others in the Supabase bucket
  if p_path is null or split_part(p_path, '/', 1) <> v_gp::text or split_part(p_path, '/', 2) <> auth.uid()::text
     or (split_part(p_path, '/', 3) !~ '^r2' and
         not exists (select 1 from storage.objects o where o.bucket_id = 'account-copies' and o.name = p_path)) then
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

-- After the panel deleted the files: R2 files are trusted gone (the Worker deleted them).
create or replace function public.admin_account_photo_purged(p_ids uuid[])
returns integer language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_n integer;
begin
  select case when count(distinct a.gp_id) = 1 then min(a.gp_id) else -1 end into v_gp
    from public.account_photos a where a.id = any (coalesce(p_ids, '{}'));
  perform private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  update public.account_photos a set purged_at = now()
   where a.id = any (p_ids) and a.purged_at is null
     and (split_part(a.path, '/', 3) ~ '^r2'
          or not exists (select 1 from storage.objects o where o.bucket_id = 'account-copies' and o.name = a.path));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

select 'OK: Account copy photos on R2 (v183) installed' as result;
