-- =====================================================================
-- Gram Setu — Payment pipeline: MR-wise stages for ALL works (v220, 2026-11-16)
--
-- The "MR-wise e-MB & Wagelist Consolidated Report" (R4.2 + R4.4 public
-- reports; Tampermonkey script and the Raspberry Pi sync read the same
-- pages) knows, for every MR of every work: filled / zero, e-MB entry,
-- AE verification, wage list date + number. The script / Pi now send each
-- GP's MRs here with the same sync key as the IAY Tracker, and the Admin
-- 💸 Pipeline tab shows MR fill → e-MB → AE verification → Wage List for
-- all works (IAY too).
--
--   mr_report_sync(p_key, p_jc_prefix, p_gp_name, p_rows, p_source)  script / Pi (anon, sync key)
--   admin_pipeline_mrs(p_gp_id)                                      Admin panel
--
-- One GP's rows are replaced on every send. No worker names are stored
-- (work name, MR number, dates and amounts only).
-- Needs v192 (IAY sync key) and v217. Safe to run again.
-- =====================================================================

create table if not exists public.pipeline_mrs (
  gp_id      smallint not null references public.gram_panchayats(id),
  work_code  text not null,
  work_name  text,
  mr_no      text not null,
  mr_type    text,
  date_from  date,
  date_to    date,
  filled     boolean not null default false,
  zero       boolean not null default false,
  meas_date  date,
  verif_date date,
  total      numeric(14, 2),
  unskilled  numeric(14, 2),
  material   numeric(14, 2),
  wl_date    text,
  wl_no      text,
  primary key (gp_id, work_code, mr_no)
);
create index if not exists pipeline_mrs_to on public.pipeline_mrs (gp_id, date_to);
alter table public.pipeline_mrs enable row level security;
revoke all on public.pipeline_mrs from anon, authenticated;

create table if not exists public.pipeline_mr_syncs (
  gp_id    smallint primary key references public.gram_panchayats(id),
  n        integer not null default 0,
  source   text,
  at       timestamptz not null default now(),
  by_user  uuid
);
alter table public.pipeline_mr_syncs enable row level security;
revoke all on public.pipeline_mr_syncs from anon, authenticated;

-- dd/mm/yyyy (or yyyy-mm-dd) → date, else null
create or replace function private.dmy(p text)
returns date language sql immutable set search_path to '' as $$
  select case when coalesce(p, '') ~ '^\d{1,2}/\d{1,2}/\d{4}' then to_date(substring(p from '^\d{1,2}/\d{1,2}/\d{4}'), 'DD/MM/YYYY')
              when coalesce(p, '') ~ '^\d{4}-\d{2}-\d{2}' then substring(p from '^\d{4}-\d{2}-\d{2}')::date end
$$;

-- live stage of one MR (today = India date), same rules as the script
create or replace function private.mr_stage(r public.pipeline_mrs, p_today date)
returns text language sql stable set search_path to '' as $$
  select case
    when r.zero then 'zero'
    when coalesce(r.wl_no, '') <> '' or coalesce(r.wl_date, '') <> '' then 'wl_done'
    when not r.filled and r.meas_date is null then
      case when r.date_to is null then 'fill_pending' when r.date_to > p_today then 'running'
           when r.date_to = p_today then 'fill_today' else 'fill_pending' end
    when r.meas_date is null then 'emb'
    when r.verif_date is null then 'verify'
    else 'wl_pending' end
$$;

-- ---------- script / Pi: one GP's MRs ----------
--   p_rows [{code, name, mr, type, from "dd/mm/yyyy", to, filled, zero, meas, verif, tot, usk, mat, wl_date, wl_no}]
create or replace function public.mr_report_sync(p_key text, p_jc_prefix text, p_gp_name text, p_rows jsonb, p_source text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare k public.iay_sync_keys%rowtype; p public.profiles%rowtype; v_gp smallint; v_scope text; v_code8 text; v_n int;
begin
  if p_key is null or p_key !~ '^iay_[0-9a-f]{48}$' then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  select * into k from public.iay_sync_keys
   where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex') and revoked_at is null;
  if not found then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  select * into p from public.profiles where user_id = k.user_id and active;
  if not found or p.role not in ('super_admin', 'gp_admin') then raise exception 'BAD_KEY' using errcode = '28000'; end if;
  if p_jc_prefix is null or p_jc_prefix !~ '^WB-[0-9]{2}-[0-9]{3}-[0-9]{3}$' then raise exception 'BAD_GP'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select g.id into v_gp from public.gram_panchayats g where g.jc_prefix = p_jc_prefix and g.active;
  if v_gp is null then return jsonb_build_object('skipped', 'GP not in Gram Setu'); end if;
  if p.role = 'gp_admin' then
    select g.jc_prefix into v_scope from public.gram_panchayats g where g.id = p.gp_id and g.active;
    if v_scope is null or v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  end if;
  v_code8 := replace(substr(p_jc_prefix, 4), '-', '');            -- 08005014 (work code = 32 + this + /…)

  delete from public.pipeline_mrs where gp_id = v_gp;
  insert into public.pipeline_mrs (gp_id, work_code, work_name, mr_no, mr_type, date_from, date_to, filled, zero,
                                   meas_date, verif_date, total, unskilled, material, wl_date, wl_no)
  select distinct on (upper(x->>'code'), x->>'mr')
         v_gp, upper(x->>'code'), left(x->>'name', 200), left(x->>'mr', 30), left(x->>'type', 10),
         private.dmy(x->>'from'), private.dmy(x->>'to'),
         coalesce((x->>'filled')::boolean, false), coalesce((x->>'zero')::boolean, false),
         private.dmy(x->>'meas'), private.dmy(x->>'verif'),
         nullif(x->>'tot', '')::numeric, nullif(x->>'usk', '')::numeric, nullif(x->>'mat', '')::numeric,
         left(nullif(x->>'wl_date', ''), 200), left(nullif(x->>'wl_no', ''), 400)
    from jsonb_array_elements(p_rows) x
   where coalesce(x->>'code', '') ~ '^[0-9]{10}/' and substr(x->>'code', 3, 8) = v_code8 and coalesce(x->>'mr', '') <> '';
  get diagnostics v_n = row_count;

  insert into public.pipeline_mr_syncs as t (gp_id, n, source, at, by_user)
  values (v_gp, v_n, left(coalesce(p_source, 'script'), 60), now(), k.user_id)
  on conflict (gp_id) do update set n = excluded.n, source = excluded.source, at = now(), by_user = excluded.by_user;
  update public.iay_sync_keys set last_used_at = now() where id = k.id;
  return jsonb_build_object('mrs', v_n);
end $$;

-- ---------- Admin ----------
create or replace function public.admin_pipeline_mrs(p_gp_id smallint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := private.require_admin_gp(p_gp_id); v_t date := private.iay_today(); v_s public.pipeline_mr_syncs%rowtype;
begin
  select * into v_s from public.pipeline_mr_syncs where gp_id = p_gp_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'at', v_s.at, 'source', v_s.source, 'n', v_s.n, 'today', v_t,
    -- MRs still to move (everything except running / zero / wage list done)
    'rows', coalesce((select jsonb_agg(jsonb_build_object('code', m.work_code, 'name', left(m.work_name, 90), 'mr', m.mr_no,
                 'to', m.date_to, 's', private.mr_stage(m, v_t), 'tot', m.total, 'meas', m.meas_date) order by m.date_to, m.work_code)
               from public.pipeline_mrs m
              where m.gp_id = p_gp_id and private.mr_stage(m, v_t) in ('fill_today', 'fill_pending', 'emb', 'verify', 'wl_pending')), '[]'::jsonb),
    'counts', coalesce((select jsonb_object_agg(s, jsonb_build_object('all', n_all, 'pba', n_pba))
               from (select private.mr_stage(m, v_t) s, count(*) n_all, count(*) filter (where m.work_code ~* '/IAY/') n_pba
                       from public.pipeline_mrs m where m.gp_id = p_gp_id group by 1) c), '{}'::jsonb));
end $$;

-- ---------- grants ----------
revoke all on function private.dmy(text), private.mr_stage(public.pipeline_mrs, date) from public, anon, authenticated;
revoke all on function public.mr_report_sync(text, text, text, jsonb, text), public.admin_pipeline_mrs(smallint) from public;
grant execute on function public.mr_report_sync(text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.admin_pipeline_mrs(smallint) to authenticated;

select 'OK: Payment pipeline MR-wise report (v220) installed' as result;
