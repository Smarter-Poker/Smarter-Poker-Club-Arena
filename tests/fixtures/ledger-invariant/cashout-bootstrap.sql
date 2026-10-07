-- Actual cashout custody columns used by the conservation owner.
CREATE TABLE public.chip_escrow (
 id uuid PRIMARY KEY, amount numeric(18,2) NOT NULL,
 released_at timestamptz
);
