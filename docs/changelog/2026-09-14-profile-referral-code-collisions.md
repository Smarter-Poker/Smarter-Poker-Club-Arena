# Profile referral codes use the same form for generation and lookup

The profile INSERT trigger checked lowercase random hex, then stored it in
uppercase. An exact repeated random draw therefore missed the existing code.
The profile index was nonunique, so both profiles could keep the same code.
PromotionService looks up a profile by its exact referral code with maybeSingle;
duplicate codes would make that lookup ambiguous. The separate referral_codes
redemption table is outside this change.

Generation now normalizes before checking. A transaction reserves its candidate
with a nonblocking advisory lock; another generator skips a reserved code and
tries another. A second lookup covers a commit between the initial check and
reservation. The existing index becomes unique to protect explicit inserts and
updates as well. Caller-provided codes and exact case-sensitive lookup semantics
stay intact; explicit conflicts are rejected. Generation stops with SQLSTATE
54000 after 128 collisions instead of looping forever.

The migration checks the exact function predecessor, owner, invoker status,
grants, trigger binding and index definition. Existing duplicates stop the
installation for investigation. It changes no existing profile data and runs
under bounded table/statement locks. Function permissions are unchanged.

The PostgreSQL 17 regression gate reproduces the original duplicate, exercises
simultaneous same-seed generators while one is still uncommitted, and checks
explicit duplicate rejection, RLS roles, bounded exhaustion, rollback, migration
replay and drift refusal. This focused fixture covers referral behavior, not the
entire signup or financial trigger graph. The live preflight found 465 existing
codes with no duplicate groups; no historical duplicate corruption is claimed.
