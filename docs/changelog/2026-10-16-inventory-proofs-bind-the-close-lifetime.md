# Inventory proofs bind the installed weekly-close lifetime

The 72-hour weekly-close proof lifetime changed the certificate reader from
`7b4a5f4572a45db069b6058899614021` to `f4d3b9bd8722bb1d8f13f0615ff9537f`.
The inventory authority still pinned the old definition. Production readback
found exactly that one mismatch among its 40 sources. The resulting null
generation disabled inventory cache reads and writes. A self-aborting diagnostic
of the original union week timed out rebuilding raw inventory before payment.

Migration `20261016132741` replaces only that pin and adds the exact lifetime
helper as dependency 41. Its preimage is `4a98179afccf2d31c127f50ed5ab9270`;
its postimage is `3399cc47118164e0fff885520fdab271`. It preserves the other 39
pins, owner checks, security metadata, scheduler and settlement locks, freeze
guards, proof expiry and transaction budgets. The matcher participates in the
generation, so cached proofs are recertified through the existing accounting
path. This migration writes no financial, certificate or inventory rows.

The exact migration is selected by the existing bounded transaction admission
helper, with the same before/after maintenance checks and source-byte refusal.

`test-inventory-proof-lifetime-postgres.py` loads all 40 actual source definitions
and the actual installed certificate reader and lifetime helper on PostgreSQL 17.
It reproduces the failure, qualifies the whole migration, proves generation
invalidation and real 24-hour cached certificate reads, and refuses stale
generations, 73-hour proofs, source and ACL drift, unauthorized requests,
duplicate history, and concurrent owning locks. Whole-migration rollback and
duplicate refusal are tested. The existing required launch-floor accounting
step invokes this regression directly; no scheduled repair was added.

Verified: native PostgreSQL regression, TypeScript compilation, six admission
unit tests and ten existing recovery contracts passed locally. Hosted checks,
protected merge, installation and financial verification are separate evidence
recorded in the owning checkpoint.
