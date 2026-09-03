-- A club description and its short lobby tag line are different authored data.
-- This is deliberately its own small migration so the hot clubs table is not
-- held behind an AccessExclusive lock while the opening-wizard functions and
-- ledgers are also installed.

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS tagline text;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.clubs'::regclass
      AND conname = 'clubs_tagline_length'
  ) THEN
    ALTER TABLE public.clubs
      ADD CONSTRAINT clubs_tagline_length
      CHECK (tagline IS NULL OR char_length(tagline) <= 72)
      NOT VALID;
  END IF;
END;
$block$;

ALTER TABLE public.clubs
  VALIDATE CONSTRAINT clubs_tagline_length;

-- The line belongs to the canonical Shark Club only. It was previously
-- hard-coded into every lobby, so no other club row is backfilled from it.
UPDATE public.clubs
SET tagline = description
WHERE club_id = 25450
  AND NULLIF(btrim(tagline), '') IS NULL
  AND description ILIKE '%all fish of all shapes and sizes are welcome%';
