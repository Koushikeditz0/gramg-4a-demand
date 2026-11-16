-- =====================================================================
-- v224 · Which SQL has been run? (schema version)
--
-- Until now nothing in the database said which vNNN files were run.
-- From now on:
--   • public.schema_versions has one row per SQL file that was run.
--   • Every NEW SQL file ends with one line:
--         select private.schema_mark(225, 'short title');
--   • Admin panel header shows "DB v224". If the app needs a newer SQL
--     than the database has, it shows a red "run SQL vNNN" warning.
--
-- Baseline: on 2026-11-16 every file up to v223 was checked in the live
-- database (one table/function from each file exists), so v223 is recorded
-- as the starting point. Older numbers are not listed one by one.
--
-- Supabase dashboard → project gramg-4a-demand → SQL Editor → paste all → Run.
-- Safe to run twice.
-- =====================================================================
begin;

create table if not exists public.schema_versions (
  version     integer primary key,
  title       text not null default '',
  applied_at  timestamptz not null default now(),
  applied_by  text not null default current_user
);
alter table public.schema_versions enable row level security;
revoke all on public.schema_versions from anon, authenticated;

-- Called at the end of every SQL file (runs as the SQL Editor user).
create or replace function private.schema_mark(p_version integer, p_title text)
returns void language sql security definer set search_path to '' as $$
  insert into public.schema_versions (version, title)
  values (p_version, coalesce(p_title, ''))
  on conflict (version) do update set title = excluded.title, applied_at = now();
$$;
revoke all on function private.schema_mark(integer, text) from public, anon, authenticated;

-- Admin panel: current DB version + the last few files run.
create or replace function public.db_version()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform private.admin_scope();          -- Super Admin or GP Admin only
  return jsonb_build_object(
    'version', (select max(version) from public.schema_versions),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('v', s.version, 't', s.title, 'at', s.applied_at) order by s.version desc)
                        from (select * from public.schema_versions order by version desc limit 5) s), '[]'::jsonb)
  );
end $$;
revoke all on function public.db_version() from public, anon;
grant execute on function public.db_version() to authenticated;

select private.schema_mark(223, 'baseline: v175–v223 checked present on 2026-11-16 (v223 = Aadhaar collection removed)');
select private.schema_mark(224, 'schema_versions table + db_version()');

commit;
