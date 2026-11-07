-- =====================================================================
-- G RAM-G 4A List Builder — K-Desk "🏦 Account Sync" (v186, 2026-11-07)
--
-- K-Desk reads the bank account of each job card on the portal page
-- pension_scheme.aspx (one job card at a time, like the Readiness Report)
-- and sends them here with the GP's "kdesk" login, a few job cards at a time.
-- Nothing is kept inside K-Desk.
--
--   kdesk_account_cards()      job cards of this GP that still have a worker
--                              without an account (so a second run only does
--                              the rest)
--   kdesk_save_accounts(rows)  rows = [{jc, ap, name, ac, ifsc, bank}]
--                              match: job card (A/B suffix ignored) + Applicant No,
--                              else the closest name on that job card.
--                              Valid A/C (6–20 digits) + IFSC only; a different
--                              account in the data is replaced (the portal is right).
--
-- Run once in Supabase → SQL Editor. Safe to run again.
-- =====================================================================

alter table public.worker_accounts add column if not exists source text;
alter table public.worker_accounts add column if not exists bank_name text;

create or replace function private.base_card(p text)
returns text language sql immutable set search_path to '' as $$
  select regexp_replace(private.norm_card(p), '-[A-Z]$', '')
$$;

create or replace function public.kdesk_account_cards()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk();
begin
  return jsonb_build_object(
    'prefix', (select g.jc_prefix from public.gram_panchayats g where g.id = v_gp),
    'workers', (select count(*) from public.workers w where w.gp_id = v_gp and w.active),
    'with_account', (select count(*) from public.workers w join public.worker_accounts a on a.worker_id = w.id
                      where w.gp_id = v_gp and w.active and coalesce(a.account_no, '') <> ''),
    'cards', coalesce((
      select jsonb_agg(jsonb_build_object('c', x.c, 'v', x.v, 'n', x.n) order by x.v, x.h, x.c)
      from (select private.base_card(w.job_card_no) c, min(w.village_no) v, min(w.household_no) h, count(*) n
              from public.workers w
              left join public.worker_accounts a on a.worker_id = w.id
             where w.gp_id = v_gp and w.active and coalesce(a.account_no, '') = ''
             group by 1) x), '[]'::jsonb));
end $$;

create or replace function public.kdesk_save_accounts(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_gp smallint := private.require_kdesk(); v_uid uuid := auth.uid();
        v_new int := 0; v_upd int := 0; v_same int := 0; v_bad int := 0; v_unmatched jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;

  create temp table if not exists _acs (ord int, b text, ap int, nm text, raw_name text, ac text, ifsc text, bank text, ok boolean) on commit drop;
  truncate pg_temp._acs;
  insert into pg_temp._acs
  select x.ord, private.base_card(x.r->>'jc'),
         case when coalesce(x.r->>'ap', '') ~ '^[0-9]{1,4}$' then (x.r->>'ap')::int end,
         lower(regexp_replace(coalesce(x.r->>'name', ''), '[^A-Za-z]+', '', 'g')),
         left(coalesce(x.r->>'name', ''), 100),
         regexp_replace(coalesce(x.r->>'ac', ''), '[\s-]', '', 'g'),
         upper(regexp_replace(coalesce(x.r->>'ifsc', ''), '\s+', '', 'g')),
         nullif(left(btrim(coalesce(x.r->>'bank', '')), 100), ''),
         true
    from jsonb_array_elements(p_rows) with ordinality x(r, ord);
  update pg_temp._acs set ok = false where ac !~ '^[0-9]{6,20}$' or ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$';
  select count(*) into v_bad from pg_temp._acs where not ok;

  -- candidates: workers on those job cards (A/B suffix belongs to the same family card)
  create temp table if not exists _acw (wid bigint, b text, ap int, nm text) on commit drop;
  truncate pg_temp._acw;
  insert into pg_temp._acw
  select w.id, private.base_card(w.job_card_no), w.applicant_no, lower(regexp_replace(w.applicant_name, '[^A-Za-z]+', '', 'g'))
    from public.workers w
   where w.gp_id = v_gp and left(w.job_card_no, 13) = (select g.jc_prefix from public.gram_panchayats g where g.id = v_gp)
     and private.base_card(w.job_card_no) in (select distinct b from pg_temp._acs where ok);

  create temp table if not exists _acm (ord int, wid bigint, score real) on commit drop;
  truncate pg_temp._acm;
  -- each portal row → its best worker: same Applicant No + similar name, else best name
  insert into pg_temp._acm
  select distinct on (s.ord) s.ord, w.wid,
         (case when w.ap = s.ap then 1 else 0 end) + extensions.similarity(w.nm, s.nm)
    from pg_temp._acs s join pg_temp._acw w on w.b = s.b
   where s.ok and ((w.ap = s.ap and (s.nm = '' or extensions.similarity(w.nm, s.nm) >= 0.2))
                   or extensions.similarity(w.nm, s.nm) >= 0.45)
   order by s.ord, (case when w.ap = s.ap then 1 else 0 end) + extensions.similarity(w.nm, s.nm) desc;
  -- one worker gets only one portal row (the best)
  delete from pg_temp._acm m using pg_temp._acm m2 where m.wid = m2.wid and (m2.score > m.score or (m2.score = m.score and m2.ord < m.ord));

  with up as (
    insert into public.worker_accounts as a (worker_id, account_no, ifsc, bank_name, source, updated_at)
    select m.wid, s.ac, s.ifsc, s.bank, 'portal', now() from pg_temp._acm m join pg_temp._acs s on s.ord = m.ord
    on conflict (worker_id) do update
       set account_no = excluded.account_no, ifsc = excluded.ifsc, bank_name = excluded.bank_name,
           source = 'portal', updated_at = now()
     where (a.account_no, a.ifsc) is distinct from (excluded.account_no, excluded.ifsc)
    returning (xmax = 0) as inserted)
  select count(*) filter (where inserted), count(*) filter (where not inserted) into v_new, v_upd from up;
  v_same := (select count(*) from pg_temp._acm) - v_new - v_upd;

  select coalesce(jsonb_agg(jsonb_build_object('jc', s.b, 'ap', s.ap, 'name', s.raw_name) order by s.ord), '[]'::jsonb)
    into v_unmatched
    from pg_temp._acs s where s.ok and not exists (select 1 from pg_temp._acm m where m.ord = s.ord);

  insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
  values (v_uid, v_gp, 'accounts_synced_kdesk', 'worker_accounts', null,
          jsonb_build_object('new', v_new, 'updated', v_upd, 'same', v_same, 'bad', v_bad, 'unmatched', jsonb_array_length(v_unmatched)));
  return jsonb_build_object('new', v_new, 'updated', v_upd, 'same', v_same, 'bad', v_bad, 'unmatched', v_unmatched);
end $$;

revoke all on function public.kdesk_account_cards(), public.kdesk_save_accounts(jsonb) from public, anon;
grant execute on function public.kdesk_account_cards(), public.kdesk_save_accounts(jsonb) to authenticated;
