# Preserve the sealed inventory certificate reader

The 72-hour weekly-close proof change altered the certificate reader from
`7b4a5f4572a45db069b6058899614021` to `f4d3b9bd8722bb1d8f13f0615ff9537f`.
Exactly one of the inventory authority's 40 source pins then differed. The null
generation disabled cache reads and writes, repeatedly rebuilding raw inventory
before the original union week could prepare or pay.

Installed migration `20261016133404` restores the exact sealed certificate
reader. This PR records its applied SQL byte for byte and adds connected native
regression protection. The inventory matcher, generation, source witnesses,
security metadata, existing cached evidence and financial rows are preserved.
The other nine weekly-close proof functions retain the installed 72-hour helper;
the sealed P&L certificate reader retains its original 12-hour lifetime.
No replay of the installed migration is needed or authorized by this source PR.

PostgreSQL 17 qualification loads all 40 actual source definitions, reproduces
the null generation, runs the actual installed restoration and verifies a valid
generation and fresh certificate cache read. It tests rollback, unknown-reader
and other-source drift refusal, wrong-generation and expired-proof refusal,
unchanged matcher and idempotent already-sealed behavior. The existing required
launch-floor accounting step directly runs this regression, together with the
Phase 7 prior/concurrent-resolution and installed-watchdog qualification.

Local TypeScript, focused admission tests and native qualifications are recorded
in the task checkpoint; protected integration and live financial receipts remain
separate completion evidence. An earlier uninstalled 41-source proposal was
withdrawn after the installed restoration made it unnecessary.
