-- Reserved using scripts/reserve-migration-version.sh.
-- Additive prerequisite for atomic blind publication. Existing events retain
-- NULL until the engine first publishes a level. This transaction deliberately
-- does not install table triggers while holding ALTER TABLE's parent lock.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS blind_level_state jsonb;
COMMIT;
