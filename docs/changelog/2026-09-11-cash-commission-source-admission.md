# Cash Commission Source Admission

The unapplied accounting candidate classified a new cash commission with no
accepted hand as payable legacy. Its updated accrual owner already refused
unknown sources, but the insertion classifier did not enforce that boundary.

The private classifier now requires the original accepted hand receipt for every
new `rake_settlement` projection. Marker one stays captured, a historical NULL
marker stays legacy, and an absent receipt refuses the insertion. Existing
historical rows and other commission source types remain unchanged. The approved
legacy-bank-only branch returns before creating a new allocation; the classifier
does not convert that lookup into a new payout authority.

Eleven focused PostgreSQL 17 groups prove unknown-source refusal, actual captured
writer classification, an actual historical accepted source, and preservation of
an existing no-hand historical entitlement through payment and replay. The old
30-group proof remains bound to its original commit and was not rerun. The
separate stopped historical-concurrency diagnostics were not invoked.

The SQL remains under audit documentation pending coordinated accounting
integration. This change applies no production migration or balance update.
