# 2026-08-30 — Leaderboard Prize Setup Uses The Real Promo Wallet Owner

Leaderboard prize setup is now an owner workflow instead of a loose settings
modal.

An affiliated club cannot choose a club wallet. Its union controls the setup
and the source is the union promo wallet. A standalone club cannot choose a
union wallet. Its owner or active co-owner controls the setup and the source is
the club promo balance. Those decisions are derived in the database from the
live affiliation and role records; the browser never sends a funding-source
choice.

## What Owners Get

- An owner-only **Leaderboard Prize Setup** destination in the hamburger menu.
- First-click setup from the leaderboard action itself.
- A four-step wizard covering the reward decision, confirmed funding source,
  suggested or custom weekly/monthly plans, and final review.
- Balanced 50/30/20, top-heavy 65/25/10, even-podium, and custom plans for up
  to five places.
- Suggestions bounded by the visible promo balance, plus a clear warning when
  a custom period is larger than the current balance.
- A saved prize-program summary and planned prize badges on eligible weekly or
  monthly rankings.
- A clean disabled-prize path that skips funding and plan steps and does not
  create an accidental suggested plan.

The flow is keyboard reachable, Escape-safe, focus-contained, mobile stacked,
44-pixel target compliant, reduced-motion aware, and follows the Club Arena
#SmarterCasinoRealism visual language.

## The High-Risk Boundary

The previous payout RPC was not safe: for chip payouts it credited winners
without debiting either the union promo wallet or the standalone club promo
balance. There is not yet one canonical, idempotent batch-transfer primitive
covering both sources, their ledgers, and partial-failure recovery.

So this release does **not** pretend payout automation is complete. It removes
the client payout action, makes the legacy RPC refuse execution, and revokes it
from browser roles. Setup and display are fully wired; moving promo chips is
deliberately deferred under the explicit instruction not to build high-risk
money code.

No production chips were spent or transferred during testing.

## Verification

- Suggested union-funded wizard flow exercised through save.
- First-time disabled flow exercised through save.
- Funding-source derivation, owner authority, deep-link wiring, and payout
  retirement pinned by safety-contract tests.
- Service RPC names and payloads tested, including proof that no client funding
  source is accepted.
- TypeScript, targeted ESLint, Title Case, no-hover UI law, production build,
  and media optimization passed.
- Production migration passed a transaction-wrapped live-schema dry run before
  apply. Post-apply checks confirmed all eight columns, no direct browser write
  policies, the authenticated payout revoke, the safety-barrier function body,
  and valid/duplicate/hostile plan validation.
- Full rebased suite: 657 files and 9,591 tests passed. Production build
  provenance reported `behind-main=0`.
