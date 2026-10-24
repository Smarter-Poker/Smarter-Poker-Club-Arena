# Horse opponent memory cold-read repair

The live engine imported durable opponent profiles unreliably because historical initialization exceeded the existing 1,500 ms request budget. Production logs identify SQLSTATE 57014 in `fn_horse_exploit_profiles_read`; accepted-hand persistence itself continued working.

Scanning the existing player index still visits tens of thousands of unrelated game-context records for an active horse. The follow-up adds a concurrent partial index for the canonical historical player and game context. The read retains exact variant, mode, table size, actual-action eligibility, chronological order, both decay rates and the full 1,024-observation horizon. The original installed migration is unchanged.

The existing merged-migration applier builds the index concurrently before the short function transaction. Its normal DDL window, immutable merged bytes and invalid-index refusal remain in force. No engine replacement or financial mutation is required. The migration must validate the actual index before enabling the new read.

Qualification and installation evidence remain in `CHECKPOINT-horse-opponent-memory.md`. A passing local test or one-player read does not certify the full live request or fleet activation.
