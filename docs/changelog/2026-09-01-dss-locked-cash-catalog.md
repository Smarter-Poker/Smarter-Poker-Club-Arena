# Deep Stack Society: the locked cash catalog, the 10k reset, and one stale premise

2026-09-01. Migrations 20260901132817 and 20260901133421, applied to
production via Supabase MCP with assertions green on apply.

Dan's orders: every horse shows exactly 10,000 before the green light, and
the LOCKED cash catalog exists — 14 stakes x 10 variations per big-bet
family.

The reset first cleared the felt through player_leave_table (the canonical
tab-close refund path; benching had stopped new seating but 7 already-seated
horses were still being dealt hands), then set all 416 balances to exactly
10,000 in trigger-safe batches. Verified: 416/416 at 10,000, sum 4,160,000,
zero open seats.

The catalog seeds 980 tables — 7 families x 14 stakes x 10 variations, keyed
by deterministic seed_key (dss:<fam>:<sb-bb>:<var>), 98 per variation, $3/$6
and $4/$8 classified high, seat law asserted, the interim 70-table catalog
retired.

Two findings for the record:

1. THE ANTE PREMISE IS STALE. The directive treats cash antes as new
   functionality. The engine already collects them: FIX-219 in
   ServerTableEngineDealing honors ante_enabled (Bible V8 4.3), AnteMath
   pins the per-player convention, and CreateTableModal writes the fields.
   The ANTE tables therefore seed onto live plumbing, ante_bb 0.2 with a
   one-cent floor at micros so no table advertises a sub-cent ante.

2. CRAZY PINEAPPLE IS NOT AN ENGINE VARIANT. grep of server/src finds no
   crazy_pineapple; the shipped 'pineapple' runs the HandController discard
   flow. Its 140 locked tables are blocked on engine work (a second
   pineapple variant with the other discard timing) and were NOT seeded as
   undealable rows. Also still open from the locked doc: the ~624-table
   limit catalog (flh/flo8 exist as variants; stud/razz/badugi/2-7 do not),
   the 48-queue Spins and 144-queue heads-up ladders (engine
   SPIN_CONFIGS/SNG_CONFIGS changes), and lobby filter UI for the new
   variation chips.
