-- =====================================================================
-- G RAM-G 4A — "PBA Mandays Status" for the public PBAY report (v205, 2026-11-12)
-- Same numbers as the Tampermonkey IAY Phase Report's All GPs summary, per GP:
-- works, works with ≥1 / ≥2 / ≥3 / ≥4 e-MRs (phases 1–4), actual PD (mandays from the
-- Phase Report) and MRs with a wagelist. PD per phase and % are worked out on the page.
-- Anon via the share-link token (same scope rules as iay_public_summary).
-- =====================================================================
create or replace function private.iay_pd_core(p_scope text)
returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('jc_prefix', jc_prefix, 'gp_name', gp_name, 'works', works,
           'p1', p1, 'p2', p2, 'p3', p3, 'p4', p4, 'days', days, 'wl', wl) order by gp_name), '[]'::jsonb)
    from (select w.jc_prefix, max(w.gp_name) gp_name, count(*) works,
                 count(*) filter (where m.n >= 1) p1, count(*) filter (where m.n >= 2) p2,
                 count(*) filter (where m.n >= 3) p3, count(*) filter (where m.n >= 4) p4,
                 coalesce(sum(w.mandays), 0) days, coalesce(sum(m.wl), 0) wl
            from public.iay_works w
            left join lateral (select count(*) n, count(*) filter (where r.status = 'WL Generated') wl
                                 from public.iay_mrs r where r.work_code = w.work_code) m on true
           where p_scope is null or w.jc_prefix = p_scope
           group by w.jc_prefix) g
$$;
revoke all on function private.iay_pd_core(text) from public, anon, authenticated;

create or replace function public.iay_public_pd(p_token text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  return private.iay_pd_core(private.iay_share_scope(p_token));
end $$;
revoke all on function public.iay_public_pd(text) from public;
grant execute on function public.iay_public_pd(text) to anon, authenticated;

-- v207 (2026-11-12): Tampermonkey v1.8 format — Actual PD per phase. private.iay_pd_core now also
-- returns a1..a4: each work's mandays split MR by MR in phase order (start date, MR No),
-- at most 15 days on every Filled / WL Generated MR. Applied as migration iay_pd_status_actual_v207b
-- (window function over iay_mrs; ~0.2 s for the whole block).
