# 2026-09-09 — committed tournament move receipt certainty

## Fixed

- A tournament seat move could commit and lose its HTTP response, then become
  impossible to certify after the manager lease expired because the ordinary
  writer rejected the retry before reading its committed receipt.
- A service-only resolver now reads an existing immutable move receipt under
  the same settlement lock and returns it only when the complete expected move
  identity matches. It cannot create, retry, compensate, update, or delete a
  move; missing evidence remains an unknown outcome and keeps the move fenced.
- Engine transport uses the resolver only for this lost-response boundary.

## Verification

- Focused server tests cover exact receipt recovery, mismatched evidence,
  missing evidence, lease loss, and manager fencing.
- A disposable PostgreSQL 17 probe proves an exact committed receipt survives
  lease loss while mismatched and absent receipts cannot authorize progress.

## Release boundary

This records implementation evidence. Merge, engine adoption, database
application, and post-deploy verification remain separate release gates.
