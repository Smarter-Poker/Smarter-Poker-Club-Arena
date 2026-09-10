# Original bulk removal targets and pending outcomes

Status: locally verified; not deployed. Phase 2 remains in progress.

Bulk removal captures every selected occupancy before the first departure and deduplicates table IDs. Captured requests do not reread a replacement seat. An existing unknown removal cannot silently switch to another occupancy, and an unrelated in-flight action is not counted as this selection's success.

Operator outcomes distinguish completed, pending and failed removals. Table operations, anti-cheat, agent exclusions and the blacklist surface pending hand completion. A deferred single-table kick does not announce a wallet balance change.

Verification: 45 focused tests passed, including original selection, delayed reads, unknown-response retry, overlapping requests, exact service transport, deferred outcomes and existing anti-cheat rendering. Client TypeScript passed. Combined server regression: 8,126 passed, with 117 opt-in PostgreSQL tests run separately and passed. Combined client regression found only two old migration filename pins (17,386 passed); those pins were updated without removing occupancy/authorization assertions and their five-test suite passed. A final combined acceptance run remains required.

Review next: seat-move identity and durable outcomes. Read-only production definitions show moves currently select a source by player/table, not original occupancy, and done retries do not return the original result. No production mutation was performed.
