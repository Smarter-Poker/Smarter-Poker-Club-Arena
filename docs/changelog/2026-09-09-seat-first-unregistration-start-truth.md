# 2026-09-09 — seat-first unregistration uses actual start truth

## Fixed

- A Heads-Up Sit & Go or Spin fill-window deadline was being treated like a
  scheduled deal time. An unstarted seat-first game could therefore reject a
  valid unregister, while an interrupted launch could leave a dealt game open
  to refund if its status and completion receipt had not advanced.
- Scheduled tournaments retain their scheduled cutoff. Heads-Up Sit & Gos and
  Spins instead use locked lifecycle state, `started_at`, completed launch
  evidence, and persisted hand history. Any persisted tournament hand is
  irreversible start evidence even when an interrupted launch omitted the
  other markers.
- Wallet-funded entries still return the exact source wallet entitlement;
  satellite-funded entries still return only their tournament ticket.

## Verification

- Focused source tests cover the distinct scheduled, Heads-Up, and Spin clocks,
  immutable receipt evidence, and wallet/ticket rail preservation.
- The disposable PostgreSQL 17 rollback probe covers an expired but unstarted
  fill window and a dealt Heads-Up game with deliberately incomplete launch
  metadata; only the former can unregister.

## Release boundary

This records implementation evidence. Production application and live catalog
verification remain separate release gates.
