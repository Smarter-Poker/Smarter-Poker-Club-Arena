-- ═══════════════════════════════════════════════════════════════════════════
--  THE WHEEL IS ANCHORED TO THE INSTANT THE ENGINE CHOSE (Dan, 2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan: "THERE IS NO SOUND EFFECT OR COUNT DOWN FOR THE SPIN ANIMATION."
--
-- The countdown and its three beeps exist and are correct. They are being
-- SKIPPED, and this column is what stops that.
--
-- SpinWheel animates against a shared clock so three players see one wheel:
--
--     const elapsed = Math.max(0, Date.now() - data.revealAtMs);
--     const at = (offsetMs) => Math.max(0, offsetMs - elapsed);
--
-- Every beat already behind `elapsed` fires at once. The engine understands
-- this exactly - `spinRevealWouldSkipABeat` re-anchors the reveal to `now`
-- whenever its own anchor has passed, so the packet on the wire always carries
-- an instant the client can play in full.
--
-- The DB fallback paths do not get that packet. `buildSpinDrawFromRow` had
-- only `tournaments.started_at` to key on, and started_at is NOT the reveal
-- anchor: the engine's own telemetry (spin_reveal_lag_ms) measures a p50 of
-- 4.2 seconds between them, and 93% of spins past Dan's one-second rule. The
-- lead-in is 1000ms and the countdown 3000ms, so a 4.2s head start eats BOTH
-- of them outright. The wheel opens straight into the chase, the three
-- countdown beeps collapse onto one millisecond, and the player sees a
-- silent spinner - which is what Dan is looking at, and a plain violation of
-- the Animation Law (CLAUDE.md 10.6).
--
-- So the anchor stops being re-derived from a different column and is simply
-- written down. `spin_reveal_lag_ms` already rides the same row write, from
-- the same two numbers, at the same instant; this is its missing half.
--
-- NULL means an older spin, or a row written before the engine reached its
-- reveal. The client falls back to started_at exactly as it does today, so
-- nothing regresses on a game that has already run.
--
-- ROLLBACK: ALTER TABLE public.tournaments DROP COLUMN spin_reveal_at;
--           (the client and engine both treat NULL as "fall back to
--            started_at", so dropping it degrades rather than breaks.)

BEGIN;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS spin_reveal_at timestamptz;

COMMENT ON COLUMN public.tournaments.spin_reveal_at IS
  'The wall-clock instant the engine anchored this Spin''s reveal to - the same number it puts on the spin_reveal packet as reveal_at. Read by buildSpinDrawFromRow so a client that missed the broadcast animates the wheel against the engine''s clock instead of started_at, which is ~4.2s earlier at the p50 and skips the entire lead-in and countdown. NULL on older rows; the client falls back to started_at.';

COMMIT;
