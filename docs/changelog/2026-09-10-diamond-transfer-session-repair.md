# Diamond Transfer Session And Retry Repair

The Phase 3 through 5 recheck reproduced a Phase 4 transfer entry-point gap: a signed JWT could invoke the transfer writer after its session was revoked. The wallet also discarded a saved transfer identity for any authorization error, even when an earlier response was lost.

The forward migration adds the existing live-session guard to the authenticated-only writer. The client retains unresolved request identities for session and ambiguous errors; the accepted-friend refusal remains editable because it follows the receipt lookup.

Validation: 37 isolated SQL assertions and six wallet component tests passed. The new component regression failed on the original code. Published through PR 4078 as 810c709d, with the database guard applied as 20260910015108 after frontend publication. Exact CI, runtime, read-only session-refusal and authenticated UI evidence is recorded in the prior-phase recheck audit. No real player transfer, balance change or seat mutation was used.
