# Rake audits read the dealt roster

The 20:38 BBJ alert and 20:40 rake-law incidents used `rake_records.num_players` as the number dealt. That field is the contribution-key count: the accepted-hand guard explicitly binds it to `_accepted_post_commit_facts.contributions`. A player who folds without contributing is still dealt a hand. Changing that producer alone would break the existing settlement contract.

Migration `20261015214329` corrects both eligibility readers to prefer the immutable `hand_history.players` roster, preserving the existing fee-count fallback when no array roster is available. It changes neither settlement nor any monetary value, threshold, journal, historical accepted payload or permissions. The exact two preimages and anchored substitutions are retained under `scripts/ci/fixtures/rake-dealt-roster`.

A read-only production comparison on the 50 hands behind the new incidents found 94 existing findings and zero under the corrected reader, using the unchanged production price functions. Native PostgreSQL tests execute the actual before/after readers against controlled pricing dependencies: they reproduce the false positives, keep real two-player BBJ and over-rake findings, preserve missing-roster fallback, and verify rollback, freeze, replay/source hashes and authority. These tests qualify roster forwarding, not the pricing rules themselves. The existing rake-audit native workflow executes them.

An initial local engine-only approach was withdrawn before push after tracing the database contract. Its patch is archived as rejected work; no engine release is needed here. Alert closure and production installation remain separate work.
