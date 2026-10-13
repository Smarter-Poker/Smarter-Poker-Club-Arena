-- Exact two table CREATE statements from installed protected 20261005152000; native-only, not replay.
CREATE TABLE IF NOT EXISTS public.poker_diamond_jackpot_pools (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arena_id            uuid NOT NULL REFERENCES public.clubs(id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'retired', 'retired_settled')),
  merged_into_pool_id uuid REFERENCES public.poker_diamond_jackpot_pools(id),
  main_residue        numeric NOT NULL DEFAULT 0 CHECK (main_residue >= 0 AND main_residue < 1),
  backup_residue      numeric NOT NULL DEFAULT 0 CHECK (backup_residue >= 0 AND backup_residue < 1),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- merged_into_pool_id is NULL on purpose in the second branch of B22: when
  -- no pool survives there is no successor to name, and the money went to the
  -- contributing players instead. The withdraw door, not a CHECK, is what
  -- requires a settled pool to hold nothing - a bank's balance is the sum of
  -- its rows, which a row constraint cannot see.
  CONSTRAINT poker_diamond_jackpot_pool_succession
    CHECK (merged_into_pool_id IS NULL OR status <> 'active')
);

CREATE TABLE IF NOT EXISTS public.poker_diamond_jackpot_ledger (
  id             bigserial PRIMARY KEY,
  pool_id        uuid NOT NULL REFERENCES public.poker_diamond_jackpot_pools(id) ON DELETE RESTRICT,
  bank           text NOT NULL CHECK (bank IN ('main', 'backup', 'promotional')),
  -- A drop comes in from a hand. A payout goes out to a person. A reseed and a
  -- merge move between banks or between pools; each writes BOTH legs, so the
  -- sum over every row of every bank is the Diamonds the jackpot holds.
  kind           text NOT NULL CHECK (kind IN ('drop', 'payout', 'reseed_in', 'reseed_out',
                                               'merge_in', 'merge_out')),
  -- WHOLE DIAMONDS, signed: positive into the bank, negative out of it. A
  -- Diamond is indivisible and so is every row here.
  amount         bigint NOT NULL CHECK (amount <> 0),
  table_id       uuid REFERENCES public.tables(id) ON DELETE RESTRICT,
  hand_number    bigint CHECK (hand_number IS NULL OR hand_number >= 1000000),
  -- Who paid this Diamond in (a drop) or who it was paid out to (a payout).
  -- A horse is a profile, like everybody else, and is named here like
  -- everybody else. CLAUDE.md 10.5: a horse earns and is paid everything a
  -- human is from the same action, a jackpot included. There is no is_horse
  -- column, predicate or branch anywhere in this file, and the law test
  -- pinned beside it refuses one.
  payer_user_id     uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_user_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_role    text CHECK (recipient_role IN ('loser', 'winner', 'table')),
  wallet_journal_id uuid,
  ref            text NOT NULL CHECK (btrim(ref) <> ''),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poker_diamond_jackpot_drop_is_in
    CHECK (kind <> 'drop' OR (amount > 0 AND table_id IS NOT NULL AND hand_number IS NOT NULL
                              AND payer_user_id IS NOT NULL AND recipient_user_id IS NULL
                              AND recipient_role IS NULL)),
  CONSTRAINT poker_diamond_jackpot_payout_is_out
    CHECK (kind <> 'payout' OR (amount < 0 AND table_id IS NOT NULL AND hand_number IS NOT NULL
                                AND recipient_user_id IS NOT NULL AND recipient_role IS NOT NULL
                                AND wallet_journal_id IS NOT NULL AND payer_user_id IS NULL)),
  CONSTRAINT poker_diamond_jackpot_move_has_no_person
    CHECK (kind IN ('drop', 'payout')
           OR (payer_user_id IS NULL AND recipient_user_id IS NULL AND recipient_role IS NULL
               AND wallet_journal_id IS NULL)),
  CONSTRAINT poker_diamond_jackpot_move_signs
    CHECK (kind NOT IN ('reseed_in', 'merge_in') OR amount > 0),
  CONSTRAINT poker_diamond_jackpot_move_signs_out
    CHECK (kind NOT IN ('reseed_out', 'merge_out') OR amount < 0)
);

