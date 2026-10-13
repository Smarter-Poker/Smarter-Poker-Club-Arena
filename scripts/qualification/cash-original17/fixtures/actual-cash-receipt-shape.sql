-- Exact maintained real receipt TABLE/PK/FK/RLS/ACL/append-only source, no financial fixture seed.
BEGIN;
CREATE TABLE public.poker_diamond_hand_receipts (
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE RESTRICT,
  hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  request jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, hand_number)
);
ALTER TABLE public.poker_diamond_hand_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.poker_diamond_hand_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.poker_diamond_hand_receipts TO service_role;
CREATE TRIGGER poker_diamond_hand_receipts_append_only BEFORE UPDATE OR DELETE
  ON public.poker_diamond_hand_receipts FOR EACH ROW
  EXECUTE FUNCTION public.fn_poker_diamond_append_only();

COMMIT;
