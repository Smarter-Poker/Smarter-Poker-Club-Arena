# Horse content retention preserves earned statistics

## Change 1: retain accepted derived basis before erasing original contents

**Files:** `supabase/migrations/*_horse_fact_cards_age_out_without_erasing_player_totals.sql`, `scripts/verification-harness/horse-fact-card-proof.py`, `scripts/verification-harness/horse-fact-card-preimage.json`.

**What existed:** the raw-request compactor and cash-copy compactor erased accepted `stats_facts` together with hand contents. Earlier fact pruning could already have deleted the last projected fact rows. The last durable basis for earned statistics could therefore disappear.

**What changed:** the original compaction transaction first saves an immutable compact basis containing every accepted derived statistic and transfer, removing only each fact's `hole_cards`. It preserves the original digest, request hash and hand identity, validates original request/atomic agreement, and refuses unknown fields or conflicting copies. Both immutable row owners require this exact basis before accepting erasure, including callers that bypass the compaction helpers. Missing or conflicting evidence preserves the original copies; it never invents settlement success.

**Why:** eight-day hand-content retention must not erase indefinite accounting and statistics evidence.

**Verified:** YES. Native PostgreSQL 17 exercised actual captured cash/P&L/replay functions and the original pruning owner. Exact money evidence and stack replay response remain identical. Direct raw/cash erasure without a basis is refused. A mismatching original accepted basis rolls back the whole transition.

## Change 2: remove card contents without deleting fact rows or totals

**What existed:** `fn_prune_ca_hand_facts(integer)` deleted horse fact rows using current profile classification. The actual DELETE transition triggers subtracted hands, fees and net results from daily, retained-play and roster totals. Horse facts belonging to mixed human hands were also eligible.

**What changed:** the existing bounded retention entry point removes only `hole_cards` after original horse/success/age evidence, disputes, unresolved F06 obligations and original roster membership have been verified. Every noncard field and all three derived summaries remain exact. A permanent trigger prevents restoring retired original cards and preserves unrelated newly admitted facts. Shared admission locks and a nonblocking exclusive retirement lock serialize the same hand's transition.

**Why:** the owner authorizes bulk content retention, while horses retain the same earned statistics and accounting treatment as humans. Human, mixed, unknown, incomplete, failed, reported or otherwise unresolved records remain protected.

**Verified:** YES. Native evidence `facts-native-source18/result.json` passed 53 assertions against frozen SQL SHA256 `b31b98d62b1b6e0cd0a0ea62b733b3ec2a1528ce0bed635457b242591b92f5c2`. It reproduces the old mixed-hand fact/counter loss, checks every noncard field and all three actual rollups, refuses migration replay and unauthorized mutations, and uses two concurrent database sessions to prove busy admission skips retirement without erasing cards. The maintained `qualify(e, template, migration)` module is intended for the existing native key/cash verification chain; integration execution is recorded by the owning delivery separately.

**TypeScript:** not applicable to this SQL/Python change; no TypeScript behavior changed.

Installation, job resumption, protected merge and production readback are separate pending steps owned by the primary delivery agent. No production writes or counter/balance restoration occurred in this qualification. Historical missing statistics are not claimed reconstructed. No new schedule, repair loop or release mechanism was added.
