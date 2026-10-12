# V31 Validators Have One Versioned Door

The Phase 6 immutable-feature migration retained legacy and versioned validator overloads. The existing one-door source law correctly rejected the signature change, and named omitted-version calls would be ambiguous after adding defaults without removing the legacy signatures.

Reserved migration `20261007034442` preserves the exact versioned bodies, adds a NULL default for omitted legacy calls, and ordinarily drops the old signatures in dependency order. Browser grants remain absent; service-role access and connected versioned constraints remain intact. Installed migration `20261007030040` is unchanged and must not be replayed.

Qualification covers named and positional legacy calls, explicit V2, unknown/null request rejection, unchanged constraints and permissions, ordinary upgrade, executable rollback, and reapplication. The combined runner unwinds the newer validator migration before rolling back its feature-contract prerequisite. The original failing source law passes all five tests.

Production dependency inspection found no catalog dependencies on the superseded signatures and verified all four exact function preimages. Source qualification and this note are not production installation, protected merge, corpus qualification, or live-worker proof. Failed pilot quality remains failed; no acceptance limit was relaxed.
