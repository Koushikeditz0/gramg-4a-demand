-- =====================================================================
-- G RAM-G 4A List Builder — Account copy photos (2026-10-31)
--
-- The supervisor photographs a worker's bank passbook / account copy in
-- the phone app. The photo goes to a PRIVATE Storage bucket. The Admin
-- (Super Admin: all GPs, GP Admin: own GP only) sees the list, opens a
-- photo through a link that works for 5 minutes, downloads it and marks
-- it Done. Done photos are deleted at once; any photo older than 30 days
-- is deleted the next time an admin opens the "Account copy" page.
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

-- 1. Private bucket: JPEG only, max 600 KB per photo --------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('account-copies', 'account-copies', false, 614400, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 614400, allowed_mime_types = array['image/jpeg'];

-- 2. Photo register -----------------------------------------------------
create table if not exists public.account_photos (
  id           uuid primary key default gen_random_uuid(),
  gp_id        smallint not null references public.gram_panchayats(id),
  worker_id    bigint not null references public.workers(id) on delete cascade,
  list_id      uuid references public.demand_lists(id) on delete set null,
  path         text not null unique,
  size_bytes   integer,
  uploaded_by  uuid not null,
  uploaded_at  timestamptz not null default now(),
  status       text not null default 'new' check (status in ('new', 'done', 'replaced')),
  done_at      timestamptz,
  done_by      uuid,
  purged_at    timestamptz
);
create index if not exists account_photos_gp_idx on public.account_photos (gp_id, status) where purged_at is null;
create index if not exists account_photos_worker_idx on public.account_photos (worker_id) where purged_at is null;
alter table public.account_photos enable row level security;   -- no policies: only the functions below
revoke all on public.account_photos from anon, authenticated;

-- 3. Who may touch a file in the bucket ---------------------------------
-- Path is "<gp_id>/<user_id>/<file>.jpg".
--   upload : a supervisor (gp_user) of that GP, into their own folder
--   read / delete : the admin of that GP (Super Admin: any GP), or the
--                   supervisor who uploaded it
create or replace function private.photo_access(p_name text, p_mode text)
returns boolean language plpgsql stable security definer set search_path to '' as $$
declare v_parts text[] := string_to_array(coalesce(p_name, ''), '/'); v_p public.profiles%rowtype; v_gp smallint;
begin
  if auth.uid() is null or array_length(v_parts, 1) <> 3 or v_parts[1] !~ '^\d{1,5}$' then return false; end if;
  if not private.session_ok() then return false; end if;
  select * into v_p from public.profiles where user_id = auth.uid() and active;
  if not found then return false; end if;
  v_gp := v_parts[1]::smallint;
  if p_mode = 'insert' then
    return v_p.role = 'gp_user' and v_p.gp_id = v_gp and v_parts[2] = auth.uid()::text
       and v_parts[3] ~ '^[A-Za-z0-9_-]{1,80}\.jpg$';
  end if;
  if v_p.role = 'super_admin' then return true; end if;
  if v_p.role = 'gp_admin' and v_p.gp_id = v_gp then return true; end if;
  return v_p.role = 'gp_user' and v_p.gp_id = v_gp and v_parts[2] = auth.uid()::text;
end $$;
revoke all on function private.photo_access(text, text) from public, anon;
grant execute on function private.photo_access(text, text) to authenticated;

drop policy if exists "account copies upload" on storage.objects;
drop policy if exists "account copies read"   on storage.objects;
drop policy if exists "account copies delete" on storage.objects;
create policy "account copies upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'account-copies' and private.photo_access(name, 'insert'));
create policy "account copies read" on storage.objects for select to authenticated
  using (bucket_id = 'account-copies' and private.photo_access(name, 'read'));
create policy "account copies delete" on storage.objects for delete to authenticated
  using (bucket_id = 'account-copies' and private.photo_access(name, 'read'));

-- 4. Supervisor: register an uploaded photo ------------------------------
-- An earlier photo of the same worker that is not Done yet is replaced;
-- its path comes back so the app can delete the old file.
create or replace function public.add_account_photo(p_worker_id bigint, p_list_id uuid, p_path text, p_size integer)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_old text[]; v_id uuid;
begin
  if not exists (select 1 from public.workers w where w.id = p_worker_id and w.gp_id = v_gp) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
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
  insert into public.account_photos (gp_id, worker_id, list_id, path, size_bytes, uploaded_by)
  values (v_gp, p_worker_id, p_list_id, p_path, p_size, auth.uid())
  on conflict (path) do nothing
  returning id into v_id;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_gp, 'account_photo_add', 'workers', p_worker_id::text, jsonb_build_object('path', p_path, 'size', p_size));
  return jsonb_build_object('id', v_id, 'old_paths', to_jsonb(v_old));
end $$;

-- Supervisor: photo state of the workers of one list (for the 📷 buttons)
create or replace function public.get_account_photos(p_worker_ids bigint[])
returns table (worker_id bigint, status text, uploaded_at timestamptz)
language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return query
  select distinct on (a.worker_id) a.worker_id, a.status, a.uploaded_at
    from public.account_photos a
   where a.gp_id = v_gp and a.worker_id = any (coalesce(p_worker_ids, '{}'))
     and a.status in ('new', 'done') and (a.purged_at is null or a.status = 'done')
     and a.uploaded_at > now() - interval '30 days'
   order by a.worker_id, a.uploaded_at desc;
end $$;

-- 5. Admin: list, Done, clean-up ----------------------------------------
create or replace function public.admin_account_photos(p_gp_id smallint, p_status text default 'new')
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_scope smallint := private.admin_scope();
begin
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'path', a.path, 'status', a.status, 'size', a.size_bytes,
        'uploaded_at', a.uploaded_at, 'done_at', a.done_at,
        'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no, 'applicant_name', w.applicant_name,
        'village_no', w.village_no, 'account_no', wa.account_no, 'ifsc', wa.ifsc,
        'work_name', l.work_name, 'uploaded_by', coalesce(nullif(p.full_name, ''), p.username))
        order by a.uploaded_at desc)
      from public.account_photos a
      join public.workers w on w.id = a.worker_id
      left join public.worker_accounts wa on wa.worker_id = a.worker_id
      left join public.demand_lists l on l.id = a.list_id
      left join public.profiles p on p.user_id = a.uploaded_by
      where a.gp_id = p_gp_id
        and ((a.status = 'new' and a.purged_at is null and coalesce(p_status, 'new') in ('new', 'all'))
          or (a.status = 'done' and a.done_at > now() - interval '30 days' and p_status in ('done', 'all')))), '[]'::jsonb),
    'new_count', (select count(*) from public.account_photos a where a.gp_id = p_gp_id and a.status = 'new' and a.purged_at is null),
    'stored_bytes', (select coalesce(sum(a.size_bytes), 0) from public.account_photos a
                      where a.purged_at is null and (v_scope is null or a.gp_id = p_gp_id)),
    'all_gps', v_scope is null);
end $$;

-- Mark Done. The paths come back so the panel deletes the files at once.
create or replace function public.admin_account_photo_done(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_paths text[];
begin
  select case when count(distinct a.gp_id) = 1 then min(a.gp_id) else -1 end into v_gp
    from public.account_photos a where a.id = any (coalesce(p_ids, '{}'));
  perform private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  with r as (
    update public.account_photos set status = 'done', done_at = now(), done_by = auth.uid()
     where id = any (p_ids) and status = 'new' returning path)
  select coalesce(array_agg(path), '{}') into v_paths from r;
  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (auth.uid(), v_gp, 'account_photo_done', 'account_photos', null, jsonb_build_object('count', coalesce(array_length(v_paths, 1), 0)));
  return jsonb_build_object('paths', to_jsonb(v_paths));
end $$;

-- Files to delete: Done / replaced, or older than 30 days.
create or replace function public.admin_account_photo_cleanup(p_gp_id smallint)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'path', a.path))
    from public.account_photos a
   where a.gp_id = p_gp_id and a.purged_at is null
     and (a.status <> 'new' or a.uploaded_at < now() - interval '30 days')), '[]'::jsonb);
end $$;

-- After the panel deleted the files: mark them gone (only if really gone).
create or replace function public.admin_account_photo_purged(p_ids uuid[])
returns integer language plpgsql security definer set search_path to '' as $$
declare v_gp smallint; v_n integer;
begin
  select case when count(distinct a.gp_id) = 1 then min(a.gp_id) else -1 end into v_gp
    from public.account_photos a where a.id = any (coalesce(p_ids, '{}'));
  perform private.require_admin_gp(coalesce(v_gp, -1)::smallint);
  update public.account_photos a set purged_at = now()
   where a.id = any (p_ids) and a.purged_at is null
     and not exists (select 1 from storage.objects o where o.bucket_id = 'account-copies' and o.name = a.path);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.add_account_photo(bigint, uuid, text, integer), public.get_account_photos(bigint[]),
  public.admin_account_photos(smallint, text), public.admin_account_photo_done(uuid[]),
  public.admin_account_photo_cleanup(smallint), public.admin_account_photo_purged(uuid[]) from public, anon;
grant execute on function public.add_account_photo(bigint, uuid, text, integer), public.get_account_photos(bigint[]),
  public.admin_account_photos(smallint, text), public.admin_account_photo_done(uuid[]),
  public.admin_account_photo_cleanup(smallint), public.admin_account_photo_purged(uuid[]) to authenticated;

select 'OK: Account copy photos installed' as result;
