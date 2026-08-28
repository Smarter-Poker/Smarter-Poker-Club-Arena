-- THE UNIQUE KEY ON ad_placement HAS NEVER FIRED FOR A PLATFORM-WIDE PLACEMENT
--
-- `ad_placement_ad_id_slot_club_id_key` is UNIQUE (ad_id, slot, club_id) and
-- has been since Phase 1. In Postgres a UNIQUE index treats NULLs as DISTINCT
-- by default, so two rows of (same ad, same slot, club_id NULL) do not
-- conflict - and club_id is NULL on every one of the eighteen placements in
-- production, because NULL is how "every club" is spelled.
--
-- The key has therefore been decorative for its entire life. Found by probing
-- it rather than reading it: a rolled-back transaction inserted the same
-- campaign onto the same surface twice and the second insert succeeded.
--
-- IT DID NOT MATTER UNTIL TODAY, and it matters now.
--
-- Until this hour the only writer was a migration written by hand, so a
-- duplicate would have been somebody's typo in a file under review. The panel
-- can now add placements, which means two clicks of Add Placement on the same
-- surface would have produced:
--
--   * the advert rendered twice in the same rail, from one JOIN;
--   * two independent daily caps for what an operator thinks is one placement;
--   * `ON CONFLICT (ad_id, slot, club_id) DO UPDATE` in the seeding migrations
--     silently inserting instead of updating on a re-run;
--   * a 23505 branch in the API that could never fire, so the operator would
--     get a cheerful success for a thing that made a mess.
--
-- Postgres 15 added `NULLS NOT DISTINCT`, which says exactly what was meant:
-- a NULL club is a VALUE - "every club" - not a wildcard that matches nothing.
-- This project runs 17.
--
-- Verified first that no duplicate exists today, so nothing is rejected
-- retroactively. If one ever did, the right answer is to look at it, not to
-- weaken the key.
--
-- ROLLBACK
--   alter table public.ad_placement drop constraint ad_placement_ad_slot_club_key;
--   alter table public.ad_placement
--     add constraint ad_placement_ad_id_slot_club_id_key unique (ad_id, slot, club_id);

do $$
declare v_dupes int;
begin
  select count(*) into v_dupes
    from (
      select 1 from public.ad_placement
       group by ad_id, slot, club_id
      having count(*) > 1
    ) d;
  if v_dupes > 0 then
    raise exception
      '% duplicate placement group(s) already exist; resolve them before tightening the key', v_dupes;
  end if;
end $$;

alter table public.ad_placement
  drop constraint if exists ad_placement_ad_id_slot_club_id_key;

alter table public.ad_placement
  add constraint ad_placement_ad_slot_club_key
  unique nulls not distinct (ad_id, slot, club_id);

comment on constraint ad_placement_ad_slot_club_key on public.ad_placement is
  'NULLS NOT DISTINCT because a NULL club_id means "every club" - a value, not '
  'a wildcard. The default treats NULLs as distinct, so the original key never '
  'fired for a platform-wide placement, which is all eighteen of them.';

do $$
declare v_ad uuid;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ad_placement'::regclass
       and conname = 'ad_placement_ad_slot_club_key'
  ) then
    raise exception 'the replacement key was not created';
  end if;

  -- Prove it refuses the duplicate the old one accepted. Probed and rolled
  -- back inside this block, because a key that is asserted by reading its
  -- definition is exactly how the original passed review.
  select id into v_ad from public.ad_catalog limit 1;
  begin
    insert into public.ad_placement (ad_id, slot, club_id)
    values (v_ad, 'table_between_hands', null);
    insert into public.ad_placement (ad_id, slot, club_id)
    values (v_ad, 'table_between_hands', null);
    raise exception 'the replacement key still accepts a duplicate platform-wide placement';
  exception
    when unique_violation then null;  -- correct
  end;
end $$;
