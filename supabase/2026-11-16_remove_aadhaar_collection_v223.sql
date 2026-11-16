-- =====================================================================
-- v223 (2026-11-16): REMOVE Aadhaar collection (Koushik: "aadhar collection bad dao").
-- Undoes the Aadhaar part of v214. Kept: মৃত / Migrant marks (worker_marks + its RPCs) and the
-- read-only "Aadhaar seeded / Authentication" info that comes from the K-Desk ABPS Sync.
--   * all Aadhaar requests (numbers, names, history) are DELETED, tables dropped
--   * supervisor / admin / K-Desk Aadhaar RPCs, the 7-day expiry and the ABPS-sync trigger are dropped
--   * get_abps_village / get_abps_summary / get_aadhaar_news no longer read Aadhaar requests
-- The Aadhaar card photo in Cloudflare R2 (bucket gramg-photos) is NOT deleted by this SQL — delete it in
-- the Cloudflare dashboard (path is listed in the thread). Safe to run twice.
-- =====================================================================
begin;

drop trigger if exists workers_aadhaar_auth_done on public.workers;
drop function if exists private.aadhaar_auth_done();
drop function if exists public.aadhaar_submit(bigint, text, text, text, boolean, text, integer);
drop function if exists public.admin_aadhaar_list(smallint, text);
drop function if exists public.admin_aadhaar_set(bigint[], text, text);
drop function if exists public.admin_aadhaar_cleanup(smallint);
drop function if exists public.admin_aadhaar_purged(bigint[]);
drop function if exists public.kdesk_aadhaar_pending(boolean);
drop function if exists public.kdesk_aadhaar_report(jsonb);
drop function if exists private.aadhaar_expire(smallint);

-- ABPS village list: no Aadhaar request info any more
create or replace function public.get_abps_village(p_village integer)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'worker_id', w.id, 'job_card_no', w.job_card_no, 'applicant_no', w.applicant_no,
             'applicant_name', w.applicant_name, 'household_no', w.household_no,
             'abps', coalesce(w.abps, false), 'ekyc', coalesce(w.ekyc, false),
             'seeded', coalesce(w.aadhaar_seeded, false), 'auth', coalesce(w.authentication_done, false),
             'aa_need', private.aadhaar_needed(w),
             'mark', case when m.id is null then null else jsonb_build_object(
                     'reason', m.reason, 'status', m.status, 'when', m.when_text, 'note', m.note, 'admin_note', m.admin_note) end)
           order by w.household_no, w.applicant_no)
    from public.workers w
    left join public.worker_marks m on m.worker_id = w.id
    where w.gp_id = v_gp and w.active and w.village_no = p_village
      and (not (coalesce(w.abps, false) and coalesce(w.ekyc, false)) or private.aadhaar_needed(w) or m.id is not null)), '[]'::jsonb);
end $$;

create or replace function public.get_abps_summary()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('village_no', v, 'workers', n, 'abps', a, 'ekyc', e, 'both', b, 'aadhaar', aa, 'marked', mk) order by v)
    from (
      select w.village_no as v, count(*) as n,
             count(*) filter (where coalesce(w.abps, false)) as a,
             count(*) filter (where coalesce(w.ekyc, false)) as e,
             count(*) filter (where coalesce(w.abps, false) and coalesce(w.ekyc, false)) as b,
             count(*) filter (where private.aadhaar_needed(w) and m.id is null) as aa,
             count(m.id) as mk
      from public.workers w
      left join public.worker_marks m on m.worker_id = w.id and m.status <> 'returned'
      where w.gp_id = v_gp and w.active
      group by w.village_no) s), '[]'::jsonb);
end $$;

-- supervisor news: মৃত / Migrant only
create or replace function public.get_aadhaar_news()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_gp smallint := private.require_gp_user(); v_uid uuid := auth.uid();
begin
  return coalesce((select jsonb_agg(x order by x->>'at' desc) from (
    select jsonb_build_object('kind', 'mark', 'worker_id', w.id, 'name', w.applicant_name, 'job_card_no', w.job_card_no,
                              'village_no', w.village_no, 'status', m.status, 'reason', m.reason, 'comment', m.admin_note,
                              'at', m.admin_at, 'mine', m.marked_by = v_uid) as x
      from public.worker_marks m join public.workers w on w.id = m.worker_id
     where m.gp_id = v_gp and m.status <> 'new' and m.admin_at > now() - interval '10 days'
    limit 200) s), '[]'::jsonb);
end $$;

-- the data itself (numbers, names, comments, history, photo list)
drop table if exists public.aadhaar_photos;
drop table if exists public.aadhaar_requests;

insert into public.audit_logs (actor_id, gp_id, action, entity, entity_id, details)
values (auth.uid(), null, 'aadhaar_collection_removed', 'aadhaar_requests', null, jsonb_build_object('sql', 'v223'));

commit;

select 'OK: Aadhaar collection removed (v223). মৃত / Migrant marks kept.' as result;
