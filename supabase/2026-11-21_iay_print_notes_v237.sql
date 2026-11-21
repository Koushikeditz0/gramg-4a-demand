-- =====================================================================
-- Gram Setu — IAY Tracker: MR Print note per GP + date (v237, 2026-11-21)
--
-- In the "Next 35 days" table, next to "MR fill", the admin keeps a note
-- of how far the MR print of that day has gone:
--   status: no | pdf (only PDF) | print (only Print) | done (PDF & Print done)
--   note  : free text (up to 300 characters)
--
-- New table only (iay_print_notes). Nothing existing changes.
-- Read/write only through the functions below (RLS on, no table policies):
--   iay_print_notes(p_jc_prefix, p_from, p_to)       Super Admin: all GPs · GP Admin: own GP
--   iay_print_note_save(p_jc_prefix, p_date, p_status, p_note)
--     saving status 'no' with an empty note deletes the row.
-- Requires v191 (private.iay_scope / private.iay_today). Safe to run again.
-- =====================================================================

create table if not exists public.iay_print_notes (
  jc_prefix  text not null check (jc_prefix ~ '^WB-[0-9]{2}-[0-9]{3}-[0-9]{3}$'),
  fill_date  date not null,
  status     text not null default 'no' check (status in ('no', 'pdf', 'print', 'done')),
  note       text check (note is null or char_length(note) <= 300),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (jc_prefix, fill_date)
);
alter table public.iay_print_notes enable row level security;
revoke all on public.iay_print_notes from anon, authenticated;

create or replace function public.iay_print_notes(p_jc_prefix text default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope();
  v_p text := coalesce(v_scope, p_jc_prefix);
  v_t date := private.iay_today();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('jc_prefix', n.jc_prefix, 'date', n.fill_date, 'status', n.status,
                                        'note', n.note, 'updated_at', n.updated_at) order by n.fill_date, n.jc_prefix)
      from public.iay_print_notes n
     where (v_p is null or n.jc_prefix = v_p)
       and n.fill_date between coalesce(p_from, v_t - 7) and coalesce(p_to, v_t + 40)), '[]'::jsonb);
end $$;

create or replace function public.iay_print_note_save(p_jc_prefix text, p_date date, p_status text, p_note text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_scope text := private.iay_scope();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_jc_prefix is null or p_jc_prefix !~ '^WB-[0-9]{2}-[0-9]{3}-[0-9]{3}$' then raise exception 'BAD_GP'; end if;
  if v_scope is not null and v_scope <> p_jc_prefix then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_date is null then raise exception 'BAD_DATE'; end if;
  if coalesce(p_status, '') not in ('no', 'pdf', 'print', 'done') then raise exception 'BAD_STATUS'; end if;
  if v_note is not null and char_length(v_note) > 300 then v_note := left(v_note, 300); end if;

  if p_status = 'no' and v_note is null then
    delete from public.iay_print_notes where jc_prefix = p_jc_prefix and fill_date = p_date;
    return jsonb_build_object('jc_prefix', p_jc_prefix, 'date', p_date, 'status', 'no', 'note', null, 'updated_at', null);
  end if;

  insert into public.iay_print_notes (jc_prefix, fill_date, status, note, updated_by, updated_at)
  values (p_jc_prefix, p_date, p_status, v_note, auth.uid(), now())
  on conflict (jc_prefix, fill_date) do update
    set status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return jsonb_build_object('jc_prefix', p_jc_prefix, 'date', p_date, 'status', p_status, 'note', v_note, 'updated_at', now());
end $$;

revoke all on function public.iay_print_notes(text, date, date), public.iay_print_note_save(text, date, text, text) from public, anon;
grant execute on function public.iay_print_notes(text, date, date), public.iay_print_note_save(text, date, text, text) to authenticated;

select private.schema_mark(237, 'IAY Tracker: MR Print note per GP + date');
select 'OK: v237 IAY MR Print notes installed' as result;
