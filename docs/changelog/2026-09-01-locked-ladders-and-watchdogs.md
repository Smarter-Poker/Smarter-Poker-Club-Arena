# The locked seat-first ladders, the agent surfaces that saw nothing, and a ladder that watches itself

2026-09-01. Branch feat/ledger-surfaces-and-ladders.

Dan: "GO AHEAD AND FULLY BUILD ALL OF THESE ... IF THERE ARE ANY THAT YOU
CONSIDER HIGH RISK FOR DAMAGING CODE OR OTHER PAGES, DO NOT BUILD THEM."

Built:

1. HEADS-UP: the locked 144-queue grid. Nine buy-ins (1,2,5,10,25,50,100,
   250,500) x four games (nlh, plo4, plo5, short_deck) x four depth bands
   (deep 1000 / regular 500 / turbo 300 / hyper 150), every band on the same
   three-minute clock per Dan's 2026-08-23 ruling ("SPEED SHOULDN'T CHANGE,
   ONLY THE STARTING STACK"). Both copies of headsUpSpec.ts byte-identical
   (mirror test green); SNG_BOARD_SHAPES now derives from the spec instead
   of listing bands by hand; queue names stay unique (the board keys on
   them). The retired 20-chip queue plays out and stops reopening.

2. SPINS: the locked price ladder (1,2,5,10,25,50,100,250; 3 and 20
   retired) plus Short Deck as a fifth variant -- 40 queues. NOT built: the
   Std/Turbo/Hyper speed split for spins. The drawn multiplier tier sets a
   spin's stack (spinSpec bands, Dan 2026-08-23), so per-config speeds would
   re-architect the draw path. High risk, refused under Dan's carve-out.

3. AGENT SURFACES: AgentAnalyticsDashboard, AgentScoreCard and
   DistributionHistory filtered on transaction types nothing writes any
   more ('agent_to_player' era), so an agent who distributed 600,000
   through the canonical cashier saw ZERO distributions. One shared list
   (agentDistributionTypes.ts) now carries legacy + canonical types for
   READ surfaces. The legacy clawback path keeps its legacy-only list on
   purpose: canonical sends claw back through fn_agent_wallet_claim_back,
   and widening the old list would route new money through the old door.

4. RAKEBACK WATCHDOG: fn_club_rakeback_margin_violations(club)
   (20260901173043, applied) returns one row per broken ladder rule --
   margin under 10 points on any edge, player under 10%, SA direct player
   over 50%, player without an upline. Zero rows = healthy. Asserted zero
   on Deep Stack at apply time.

Verified existing, nothing to build: the lobby's family chips (NLH, Crazy
Pineapple, 6+, PLO 4c/5c/6c/Hi-Lo, FLH, FLO8) and variation chips (Ante,
Straddle, Insurance, RIT, Bomb Pot, Multi-Board) already cover the full
seeded catalog; their match keys align with the seeded columns.

Refused as high-risk, by Dan's carve-out: teaching the deploy-time chip
conservation gate about maintenance windows; occupancy-based auto table
copies (the code family that once spawned 487 duplicates); Classic
Pineapple and the Stud/Razz/Badugi/2-7/Kill engine variants (live dealing
engine surgery).

Pinned by seatFirstLadders.test.ts: exact grid sizes, unique names, one
shared blind ladder across bands, three-handed spins with a held seat.
