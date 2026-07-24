-- ═══════════════════════════════════════════════════════════════════════════════
-- 011_hand_events.sql — Event-Sourced Hand Engine durable event log
-- ═══════════════════════════════════════════════════════════════════════════════
-- Keystone Upgrade #1 (FOUNDATION). Append-only store of every hand-lifecycle
-- event emitted by the engine. The full typed event is stored verbatim in
-- `payload` (jsonb) so a hand can be replayed deterministically by HandReducer.
--
-- STATUS: authored but INTENTIONALLY NOT APPLIED. Apply as a sequenced follow-up
-- once ShadowRecorder is wired and its SupabaseEventSink is enabled.
--
-- Append-only + immutable: (hand_id, seq) is unique and monotonic per hand.

CREATE TABLE IF NOT EXISTS public.hand_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hand_id         text        NOT NULL,
    seq             integer     NOT NULL,
    event_type      text        NOT NULL,
    schema_version  integer     NOT NULL DEFAULT 1,
    -- Epoch milliseconds, passed in by the recorder (NOT a db default) so the
    -- stored timeline matches the engine's clock exactly.
    ts              bigint      NOT NULL,
    payload         jsonb       NOT NULL,
    -- When the row was persisted (server side) — audit only, not the game clock.
    inserted_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT hand_events_seq_nonneg CHECK (seq >= 0),
    CONSTRAINT hand_events_type_valid CHECK (
        event_type IN (
            'HandStarted', 'BlindsPosted', 'HoleCardsDealt', 'PlayerActed',
            'StreetAdvanced', 'ShowdownRevealed', 'PotAwarded', 'HandEnded'
        )
    ),
    -- Append-only integrity: one row per (hand, seq).
    CONSTRAINT hand_events_hand_seq_unique UNIQUE (hand_id, seq)
);

-- Replay a hand in order.
CREATE INDEX IF NOT EXISTS hand_events_hand_id_seq_idx
    ON public.hand_events (hand_id, seq);

-- Time-range / audit scans.
CREATE INDEX IF NOT EXISTS hand_events_ts_idx
    ON public.hand_events (ts);

-- Query by event type (e.g. all PotAwarded for settlement reconciliation).
CREATE INDEX IF NOT EXISTS hand_events_type_idx
    ON public.hand_events (event_type);

COMMENT ON TABLE  public.hand_events IS
    'Append-only event log for the deterministic, replayable hand engine (Keystone #1). One row per (hand_id, seq); payload is the full typed HandEvent.';
COMMENT ON COLUMN public.hand_events.ts IS
    'Epoch ms from the engine clock (recorder-supplied), not a DB default.';
COMMENT ON COLUMN public.hand_events.payload IS
    'Verbatim HandEvent JSON. Fold through HandReducer.replay() to reconstruct hand state.';

-- ── Immutability + access control ──────────────────────────────────────────────
ALTER TABLE public.hand_events ENABLE ROW LEVEL SECURITY;

-- Server (service role) writes; nobody updates or deletes (append-only).
-- No UPDATE/DELETE policies are created, so those are denied under RLS.
-- Reads are service-role only for now; add a scoped SELECT policy for audit UIs
-- as a later step.

-- Optional hard guard against mutation even for privileged roles:
CREATE OR REPLACE FUNCTION public.hand_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'hand_events is append-only; % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS hand_events_no_update ON public.hand_events;
CREATE TRIGGER hand_events_no_update
    BEFORE UPDATE OR DELETE ON public.hand_events
    FOR EACH ROW EXECUTE FUNCTION public.hand_events_block_mutation();
