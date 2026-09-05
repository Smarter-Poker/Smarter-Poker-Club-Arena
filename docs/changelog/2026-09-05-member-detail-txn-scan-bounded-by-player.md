# 2026-09-05 - The member-detail chip scan is bounded by the player

**Symptom.** Player search for a club owner took 6.8 seconds. Everyone else
got it in well under half a second.

**Cause.** `ca_club_member_detail(club, user, from, to)` builds the wallets,
downline and stats block a staff viewer sees on a player. Its `txn` CTE read
EVERY `chip_transactions` row in the club and narrowed to the player only
inside its two `FILTER` clauses:

```sql
  FROM public.chip_transactions ct
 WHERE v_sensitive AND ct.club_id = p_club_id      -- no player here
```

```sql
  sum(ct.amount)      FILTER (WHERE ct.to_user_id   = p_user_id AND ...)
  sum(abs(ct.amount)) FILTER (WHERE ct.from_user_id = p_user_id AND ...)
```

Measured on production against Midway Union (10,137 rows in the club, 38 for
its busiest member): 80ms and 2,126 buffers per call, an index-only scan of
the whole club followed by a 10,137-row filter. Every other CTE in the
function is under a millisecond; this line was the function (239ms per call
as the owner, of which ~80ms was this scan and the rest scope/access lookups).

Why it was 6.8 seconds and not 80ms: `fn_search_players` calls
`ca_club_member_detail` once per result row per club where the viewer is
staff (`sensitive_accounts`). A 50-row page for the owner of four clubs fired
it 90 times. 90 x ~80ms of wasted scan is ~7.2s.

**Fix.** Migration `20260905062510_member_detail_txn_scan_is_bounded_by_the_player`
adds the predicate the FILTERs already implied to the WHERE:

```sql
   AND (ct.to_user_id = p_user_id OR ct.from_user_id = p_user_id)
```

Both FILTERs require exactly one of those equalities, so a row that fails the
new WHERE could never have contributed to either sum; the result is identical.
The planner now uses `chip_transactions_club_to_created_idx` and
`chip_transactions_club_from_created_idx` (both already existed) as a
BitmapOr: 0.7ms, 44 buffers, the same 38 rows. No new index, no new object.
The migration body is `pg_get_functiondef()` of the live function with that
one line added, and it ends in a `DO` block that re-runs the function for the
measured member under the owner's identity and aborts the transaction if
`claimed_back` is not the 14.68 the old body returned.

**Measured after apply (production, owner identity, warm):**

| call                                                              | before           | after |
| ----------------------------------------------------------------- | ---------------- | ----- |
| `txn` CTE alone, Midway Union, busiest member                     | 80.2ms           | 0.7ms |
| `ca_club_member_detail`, same member                              | 239ms            | 80ms  |
| `fn_search_players('ma', 50, 0, 'all')` as owner, 90 detail calls | ~6.8s (reported) | 379ms |

`claimed_back` 14.68 / `sent_out` 0.00 before and after.

**Not changed.** The remaining ~80ms per detail call is `fn_club_scope_ids`
(~23ms) and `ca_club_roster_access` (~20ms) plus the rest; and
`fn_search_players` still calls the detail function per (row x club) rather
than batching. Both are further wins if the owner's page is still felt to be
slow, but neither was the 6.8 seconds.

**Pin.** `tests/unit/memberDetailTxnBounded.test.ts` reads the newest
migration that defines `ca_club_member_detail` and fails if that definition
lacks the predicate - so a later redefinition cannot quietly drop it.
