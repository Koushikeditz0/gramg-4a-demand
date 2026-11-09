-- =====================================================================
-- G RAM-G 4A — IAY pending lists behind the MR Summary numbers (v198)
--   iay_pending_list(p_jc_prefix, p_kind, p_date, p_past)            admin (login)
--   iay_public_list(p_token, p_jc_prefix, p_kind, p_date, p_past)    public link
-- kinds: older (ended before the chosen days, not filled) · day (ended on p_date, not filled)
--        all (every ended MR not filled, today included) · wl (filled, no wagelist)
-- Names / Job Cards appear only when they were synced (blank otherwise).
-- Requires v196. Safe to run again.
-- =====================================================================

create or replace function private.iay_pending_core(p_scope text, p_jc_prefix text, p_kind text, p_date date, p_past integer)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_t date := private.iay_today();
  v_from date := v_t - least(greatest(coalesce(p_past, 2), 0), 14);
  v_p text := coalesce(p_scope, p_jc_prefix);
begin
  if p_scope is not null and p_jc_prefix is not null and p_jc_prefix <> p_scope then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_kind not in ('older', 'day', 'all', 'wl') then raise exception 'BAD_KIND'; end if;
  if p_kind = 'day' and p_date is null then raise exception 'BAD_DATE'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'gp', x.gp_name, 'work_code', x.work_code, 'reg_no', x.reg_no, 'name', x.ben_name, 'jcn', x.jcn,
             'village', x.village, 'mr_no', x.mr_no, 'seq', x.seq, 'start', x.start_date, 'end', x.end_date,
             'status', x.status) order by x.gp_name, x.end_date, x.mr_no)
      from (select w.gp_name, w.work_code, w.reg_no, w.ben_name, w.jcn, w.village, r.mr_no, r.seq, r.start_date, r.end_date, r.status
              from public.iay_mrs r join public.iay_works w on w.work_code = r.work_code
             where (v_p is null or w.jc_prefix = v_p)
               and case p_kind
                     when 'wl' then r.status = 'Filled'
                     when 'older' then r.end_date < v_from and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')
                     when 'day' then r.end_date = p_date and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')
                     else r.end_date <= v_t and coalesce(r.status, '') not in ('Filled', 'WL Generated', 'Zero')
                   end
             order by w.gp_name, r.end_date, r.mr_no
             limit 20000) x), '[]'::jsonb);
end $$;

-- Scope of a public link (NULL = all GPs). Raises BAD_LINK when stopped / unknown.
create or replace function private.iay_share_scope(p_token text)
returns text language plpgsql stable security definer set search_path to '' as $$
declare k public.iay_share_links%rowtype; p public.profiles%rowtype; v_scope text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then raise exception 'BAD_LINK' using errcode = '28000'; end if;
  select * into k from public.iay_share_links where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and revoked_at is null;
  if not found then raise exception 'BAD_LINK' using errcode = '28000'; end if;
  select * into p from public.profiles where user_id = k.user_id and active;
  if not found or p.role not in ('super_admin', 'gp_admin') then raise exception 'BAD_LINK' using errcode = '28000'; end if;
  if p.role = 'gp_admin' then
    select g.jc_prefix into v_scope from public.gram_panchayats g where g.id = p.gp_id and g.active;
    if v_scope is null then raise exception 'BAD_LINK' using errcode = '28000'; end if;
  end if;
  return v_scope;
end $$;

revoke all on function private.iay_pending_core(text, text, text, date, integer), private.iay_share_scope(text) from public, anon;

create or replace function public.iay_pending_list(p_jc_prefix text, p_kind text, p_date date default null, p_past integer default 2)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  return private.iay_pending_core(private.iay_scope(), p_jc_prefix, p_kind, p_date, p_past);
end $$;

create or replace function public.iay_public_list(p_token text, p_jc_prefix text, p_kind text, p_date date default null, p_past integer default 2)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  return private.iay_pending_core(private.iay_share_scope(p_token), p_jc_prefix, p_kind, p_date, p_past);
end $$;

revoke all on function public.iay_pending_list(text, text, date, integer), public.iay_public_list(text, text, text, date, integer) from public;
grant execute on function public.iay_pending_list(text, text, date, integer) to authenticated;
grant execute on function public.iay_public_list(text, text, text, date, integer) to anon, authenticated;

select 'OK: IAY pending lists installed' as result;
