# Weekly close uses the actual maintenance freeze

The October 26 rakeback incident exposed seven minute-of-hour guards that still stop the weekly scope and proof-window paths from :45 through :59. Hourly platform maintenance was retired October 20. This change removes only those seven predicates from two exact function preimages. The daily database freeze, scheduler locks, authorization, attempt/statement budgets, scope ordering, source checks and idempotent payment receipts remain intact.

Native PostgreSQL qualification installs the exact captured production definitions and migration, verifies metadata preservation, rollback and replay refusal, then executes both maintained entry paths under controlled clocks. The old scope refuses at :45, :50 and :59; the new scope advances its calculation step and the window function advances a proof. Both still refuse while fn_platform_frozen is true. The fixtures do not execute wallet payments. The scoped pull request workflow runs this proof for migration changes.

This supports the same payout incident tracked in docs/HANDOFF-2026-10-26-weekly-rakeback-close.md (submitted in PR #8207). It does not by itself prove payout completion or resolve every slow calculation.
