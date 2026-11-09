-- =====================================================================
-- G RAM-G 4A — IAY public MR Summary link (v194, 2026-11-09)
--
-- An admin makes a share link; anyone with the link sees the day-wise
-- MR Summary (GP-wise COUNTS only — no names, Job Cards or work codes),
-- always from the latest synced data. No login needed.
--   iay_share_create() / iay_share_status() / iay_share_revoke()   admin
--   iay_public_summary(p_token, p_past, p_ahead)                    anon
-- Super Admin link = all GPs, GP Admin link = own GP. Only the token's
-- SHA-256 is stored; a new link stops the old one. Requires v193.
-- Safe to run again.
-- =====================================================================

create table if not exists public.iay_share_links (
  id           bigint generated always as identity primary key,
  token_hash   text not null unique,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_view_at timestamptz,
  views        integer not null default 0,
  revoked_at   timestamptz
);
create index if not exists iay_share_links_user_idx on public.iay_share_links (user_id) where revoked_at is null;
alter table public.iay_share_links enable row level security;
revoke all on public.iay_share_links from anon, authenticated;

-- Counts for a scope (NULL = all GPs). Shared by the admin and the public view.
create or replace function private.iay_summary_core(p_scope text, p_past integer, p_ahead integer)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_t date := private.iay_today();
  v_past int := least(greatest(coalesce(p_past, 2), 0), 14);
  v_ahead int := least(greatest(coalesce(p_ahead, 5), 0), 14);
begin
  return jsonb_build_object(
    'today', v_t, 'from', v_t - v_past, 'to', v_t + v_ahead,
    'gps', coalesce((
      select jsonb_agg(jsonb_build_object('jc_prefix', g.jc_prefix, 'gp_name', g.gp_name, 'report_at', g.report_at) order by g.gp_name)
        from (select distinct on (i.jc_prefix) i.jc_prefix, i.gp_name, i.report_at
                from public.iay_imports i
               where (p_scope is null or i.jc_prefix = p_scope)
                 and exists (select 1 from public.iay_works w where w.jc_prefix = i.jc_prefix)
               order by i.jc_prefix, i.at desc) g), '[]'::jsonb),
    'cells', coalesce((
      select jsonb_agg(jsonb_build_object('jc_prefix', x.jc_prefix, 'date', x.d, 'total', x.total, 'filled', x.filled))
        from (select w.jc_prefix, r.end_date d, count(*) total,
                     count(*) filter (where r.status in ('Filled', 'WL Generated')) filled
                from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
               where (p_scope is null or w.jc_prefix = p_scope)
                 and r.end_date between v_t - v_past and v_t + v_ahead
                 and coalesce(r.status, '') <> 'Zero'
               group by 1, 2) x), '[]'::jsonb));
end $$;
revoke all on function private.iay_summary_core(text, integer, integer) from public, anon;

create or replace function public.iay_mr_summary(p_past integer default 2, p_ahead integer default 5)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  return private.iay_summary_core(private.iay_scope(), p_past, p_ahead);
end $$;

create or replace function public.iay_share_create()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); v_tok text; v_uid uuid := auth.uid();
begin
  update public.iay_share_links set revoked_at = now() where user_id = v_uid and revoked_at is null;
  v_tok := encode(extensions.gen_random_bytes(16), 'hex');
  insert into public.iay_share_links (token_hash, user_id) values (encode(extensions.digest(v_tok, 'sha256'), 'hex'), v_uid);
  insert into public.audit_logs (actor_id, action, entity, details) values (v_uid, 'iay_share_create', 'iay', jsonb_build_object('scope', v_scope));
  return jsonb_build_object('token', v_tok, 'scope', v_scope);
end $$;

create or replace function public.iay_share_status()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); r public.iay_share_links%rowtype;
begin
  select * into r from public.iay_share_links where user_id = auth.uid() and revoked_at is null order by created_at desc limit 1;
  if not found then return jsonb_build_object('active', false); end if;
  return jsonb_build_object('active', true, 'created_at', r.created_at, 'views', r.views, 'last_view_at', r.last_view_at, 'scope', v_scope);
end $$;

create or replace function public.iay_share_revoke()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_scope text := private.iay_scope(); n int;
begin
  update public.iay_share_links set revoked_at = now() where user_id = auth.uid() and revoked_at is null;
  get diagnostics n = row_count;
  insert into public.audit_logs (actor_id, action, entity, details) values (auth.uid(), 'iay_share_revoke', 'iay', jsonb_build_object('n', n));
  return jsonb_build_object('revoked', n);
end $$;

-- Public view (no login). Counts only.
create or replace function public.iay_public_summary(p_token text, p_past integer default 2, p_ahead integer default 5)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare k public.iay_share_links%rowtype; p public.profiles%rowtype; v_scope text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then raise exception 'BAD_LINK' using errcode = '28000'; end if;
  select * into k from public.iay_share_links
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and revoked_at is null;
  if not found then raise exception 'BAD_LINK' using errcode = '28000'; end if;
  select * into p from public.profiles where user_id = k.user_id and active;
  if not found or p.role not in ('super_admin', 'gp_admin') then raise exception 'BAD_LINK' using errcode = '28000'; end if;
  if p.role = 'gp_admin' then
    select g.jc_prefix into v_scope from public.gram_panchayats g where g.id = p.gp_id and g.active;
    if v_scope is null then raise exception 'BAD_LINK' using errcode = '28000'; end if;
  end if;
  update public.iay_share_links set views = views + 1, last_view_at = now() where id = k.id;
  return private.iay_summary_core(v_scope, p_past, p_ahead);
end $$;

revoke all on function public.iay_share_create(), public.iay_share_status(), public.iay_share_revoke(),
                       public.iay_public_summary(text, integer, integer) from public;
grant execute on function public.iay_share_create(), public.iay_share_status(), public.iay_share_revoke() to authenticated;
grant execute on function public.iay_public_summary(text, integer, integer) to anon, authenticated;

select 'OK: IAY public report installed' as result;
