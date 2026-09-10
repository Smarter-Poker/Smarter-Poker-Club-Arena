# Guarantee funding proof

Run from the repository with its existing registration fixtures:

```sh
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --guarantees-only
```

The runner uses a private PostgreSQL 17 cluster. It does not use a production database URL. This fixture extends the existing registration fixture with eight captured installed function bodies, seven installed triggers, bank table shapes and the installed partial journal idempotency index. Each case checks the captured function body hashes against `source-manifest.json`.

The real registration authority supplies a 200-chip purchase: 180 prize and 20 fee. The real guarantee authority must fund a 120-chip overlay to reach the 300-chip guarantee. The expected result is one bank debit, one explicit overlay journal and its bank autojournal twin, with only 120 added to escrow. Prize escrow and final pool reach 300; fee escrow stays 20.

All nine scenario groups printed PASS on 2026-09-10:

1. Club funding and replay without writes.
2. Union funding and replay without writes.
3. A private event charges its host club despite union membership.
4. An event retains its original union funding scope after its club moves.
5. A missing union wallet falls back to the host club.
6. A bank holding 119 cannot fund 120; financial and finalization rows remain unchanged.
7. Failure at the explicit overlay journal rolls back the bank debit, autojournal, overlay claim and finalization.
8. Concurrent requests for one event fund it once.
9. Two events cannot spend the same remaining bank balance.

Evidence was observed in `/tmp/codex-entry-guarantee-run-next.log`. After all nine groups passed, the existing runner exceeded its 15-second `pg_ctl` shutdown timeout under host disk pressure. The original runner exit is therefore not reported as successful. A subsequent status check returned `3` with `no server running`; only that stopped private cluster was removed. The recovery record is `/tmp/ca-registration-funding-pg17-ricdlq9m/results-teardown-recovery.json`, with the observed recovery log at `/tmp/codex-entry-guarantee-finalize.log`. Do not repeat these nine passed groups merely to replace that teardown result.

The fixture uses synthetic authentication, initial bank capital and supporting read shapes. It does not establish HTTP/RLS behavior, a full production schema rehearsal, actual entry-window closure, obligation maturity, hand commit, or cancellation settlement. Those limits remain separate from the proven bank-to-escrow funding behavior.
