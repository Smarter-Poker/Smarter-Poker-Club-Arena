# OFC is not offered anywhere current-facing (2026-09-23)

Assignment CA-PRODUCT-COMPLETION-2026-09-22, finding P1-F11. Owner decision: no Open-Face Chinese.

- Hand labels: the legacy `ofc_pineapple` key renders as Crazy Pineapple (the retirement migration
  20260823_retire_ofc_pineapple_variant.sql found every such table was Crazy Pineapple); a bare `ofc`
  key, carried by no stored hand, renders as the generic "Poker" label instead of "OFC".
- Search and Profile label maps no longer print "OFC".
- README and docs/POKER_ENGINE.md list only dealt variants and record OFC as excluded.
- InsuranceModal comment corrected: the EV Cashout endpoint exists and is wired.
- Law: tests/ofc-is-not-offered.law.test.ts.

History (changelogs, audits, migrations, stored rows) is unchanged.
