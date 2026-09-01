# The funding flows the way Dan drew it, and two engine truths surfaced

2026-09-01. Migrations 20260901134950, 20260901135704, 20260901140350
(applied); 20260901150000 staged pending human-authorized DDL.

Dan's orders: only owners, co-owners, admins and super agents touch the club
bank (verified: fn_can_use_club_bank already says exactly that); the funding
history must show owner -> super agents (one send per branch), super agents
-> players and agents (one send covers an agent's whole subtree), agents ->
players, and every manager moving its own seat money from its own agent
wallet to its own player wallet; the old history wiped.

What shipped:

1. fn_agent_wallet_self_stake -- the move Dan described had no path
   (fn_agent_wallet_send refuses self-sends), which is why v1 funding paid
   each manager's seat from its parent. The new RPC mirrors the send's
   guards: auth actor, mandatory retry key with replay, advisory locks, row
   locks, agent-wallet roles only, no overdraft, autoledgered both legs.

2. The unwind -- all 7,500,000 (416 x 10,000 player wallets + 3,340,000
   agent banks) returned to the club bank, asserted to the chip.

3. The redo -- .agent/deep-stack-society/fund-v2.mjs replays the designed
   flow as the real actors via authenticated sessions: 2 bank sends
   (3,750,000 per branch), 414 downline sends (child managers funded in one
   shot: 600,000 per agent, 150,000 per sub agent), 32 self-stakes. 448
   idempotent transactions.

4. The wipe of pre-redo history is human-authorized (append-only maintenance
   door, rows preserved in ca_ledger_mutation_log); the SQL was handed to
   Dan with a timestamp boundary that cannot touch the clean redo rows.

Engine truths found on the way:

- chip_ledger has NO index on chain_seq: every ledger insert platform-wide
  seq-scans 316k rows / 196 MB for its prev_hash. The unwind timed out on
  it. Index staged as 20260901150000, pending apply.

- The engine's 'pineapple' IS Crazy Pineapple: the discard runs AFTER the
  flop ('preflop' -> 'flop' -> 'pineapple_discard' -> 'turn'), and
  pineappleDiscardChoice.ts says so in its first sentence. The 140 Deep
  Stack tables now carry the honest name; classic before-flop Pineapple is
  the variant the engine genuinely lacks.

- The cash ante audit came back CLEAN: per-player collection with
  partial/all-in handling, dead-money tracking (never VPIP, never a live
  bet), pot/side-pot correctness, forced-money attribution, BBA convention
  pinned by AnteMath tests (49 green). The 98 DSS ANTE tables are the first
  production rows ever to enable it.
