# 2026-08-26 — advisor sweep: what was built, and what was deliberately not

Ran the Supabase security and performance advisors properly for the first time.
**2,190 findings.** Most of the alarming headline numbers are not holes; the
work was in separating those from the few that are.

---

## Built and verified

| Fix                                                                | Verified by                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `live_help_tickets` — wrapped the last two bare `auth.uid()` calls | Bare-auth policy count `2 -> 0`; anon `GET /live_help_tickets` returns `200 []`, so RLS still denies                     |
| `pb_log_hand` × 2 overloads — refuse anonymous callers             | Both overloads carry the guard; was the only _writing_ anon-callable SECURITY DEFINER function without an identity check |
| `union_rake_weekly` — added primary key                            | 17 rows, 17 distinct `(union_id, club_id, week_start)`, 0 NULLs — checked before adding                                  |
| 10 functions — pinned `search_path`                                | `0` of the ten still mutable                                                                                             |
| `index_usage_snapshots` + 2 functions                              | 1,545 index rows captured; reader correctly **refuses** to answer from a single snapshot                                 |

On the ten `search_path` functions, worth stating plainly: **none is SECURITY
DEFINER.** A mutable `search_path` on a SECURITY INVOKER function is a
correctness and lint issue, not the privilege-escalation vector it would be on a
definer function. Lower severity than the advisor's WARN implies. Pinning to
bare `'public'` is safe here only because none of the ten touches an
extension-schema object — that was checked per function, and functions elsewhere
that do need them are pinned `'public, extensions'`.

---

## The 895 MB index question — NOT dropped, and why

1,338 unused indexes, 895 MB, 783 MB of it in ten. This is the single biggest
optimisation available on this database and it was **not** taken, because the
evidence for it does not exist yet:

```
pg_postmaster_start_time() ... 2026-08-26 16:27:36Z   (~4 hours before this)
hand_history live rows ....... 1,595,679
hand_history n_tup_ins ....... 76,233
```

76k recorded inserts against 1.6M live rows means the statistics counters were
**reset at that restart**. `idx_scan = 0` therefore means "unused in the last
four hours" and nothing more. Every index serving a nightly, weekly or monthly
job reads as unused. Dropping on that basis breaks reporting paths and the
damage surfaces days later, far from the cause.

So the evidence-gathering was built instead:

```sql
SELECT public.fn_snapshot_index_usage();         -- now, and daily
SELECT * FROM public.fn_truly_unused_indexes(7); -- after a week
```

`fn_truly_unused_indexes` compares only across a window containing **no
postmaster restart**, and returns nothing until it has one. It refuses to answer
rather than answering from reset counters — which is the whole point of it.

**Next step for whoever picks this up:** schedule `fn_snapshot_index_usage()`
daily via Open Claw (per World Hub CLAUDE.md §11, not `vercel.json`), then read
`fn_truly_unused_indexes(7)` next week. The top ten are 88% of the prize.

---

## A whole feature that has never worked

Testing the `pb_log_hand` guard over PostgREST turned up something bigger than
the guard:

```
POST /rest/v1/rpc/pb_log_hand   ->   HTTP 300   PGRST203
"Could not choose the best candidate function between:
 public.pb_log_hand(...16 args...), public.pb_log_hand(...17 args...)"
```

The two overloads differ only by a trailing `DEFAULT` argument, so PostgREST
cannot resolve **either** — for anon or for anyone. Consistent with the data:
**`pb_hands` has zero rows and has never been written to.**

Its only caller is `Smarter-Poker-World-Hub/src/lib/poker-brain/storage.js`
(lines 243 and 390), which has been retrying and queueing failures offline this
entire time.

Resolving the overloads alone would still not fix it. That caller sends
`p_engine_suggestion`, which neither overload accepts and for which `pb_hands`
has **no column**. Broken at three layers.

**Not fixed here.** Completing someone's half-built feature from the database
side is a guess at product intent, and guessing is how you damage things. Left
for its owner with the diagnosis written down.

---

## Deliberately not built (high risk)

| Item                                                                               | Why not                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop 1,338 unused indexes (895 MB)                                                 | Evidence invalid — stats reset 4h ago. Snapshot built instead.                                                                                             |
| Revoke reads on ~180 anon-readable tables                                          | Most are correct for a public poker-information site. Broad revocation breaks the product; picking which is a product decision. Triage list already filed. |
| The 583 `authenticated` SECURITY DEFINER functions                                 | Same audit as the 93 needs doing first. A blanket change to 583 money-adjacent functions is not something to attempt in one pass.                          |
| 2 SECURITY DEFINER views (`trivia_tournaments_public`, `v_spin_tier_availability`) | Switching to `security_invoker` changes who can read them and can break pages that depend on definer privileges. Needs someone who knows the intent.       |
| Drop the duplicate `fn_run_pending_rakeback_settlement` overload                   | Settlement money path. Tier 3 per CLAUDE.md §11.5.                                                                                                         |
| Auth server 10-connection cap → percentage-based                                   | Dashboard/management-API only; no tool path from here. **Still outstanding and still real.**                                                               |

---

## Corrections to earlier claims in this session

- **"0 bare auth policies"** was scoped too narrowly — the regex only covered
  `auth.uid|jwt|role()`. The advisor also counts `current_setting()`, which
  found 2 more on `live_help_tickets`. Now genuinely 0 by both definitions.
- **"Auth pool: no action needed"** was based on the wrong measurement. Total DB
  connections (36/120) is not the finding; the Auth _server's_ own 10-connection
  cap is. That item was real and remains open.
