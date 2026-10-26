# Activate the protected PLO receipt correction

The owner explicitly ordered immediate activation of the PLO horse fixes rather than waiting for 04:00. PR #8220 merged as `7fdb2223b24acf54ce11440531347890fcd61897`; the serving `6d016cce` does not contain it. Existing activation anchors have already been served and cannot admit this correction.

Prepend one four-hour owner entry naming the actual protected merge. It ends when that merge is serving. The existing stage/receiver remains the only publisher, with exact source selection, last-hand notice, hand-boundary drain, durable freeze, maintenance certificate, cutover/rollback reserve, seal and thaw. No migration or runtime policy is changed by this entry.

Validation: focused daily/off-cycle/withdrawal contract tests and the existing operational recovery-window tests. Protected checks, sealed installation, exact serving identity and natural-hand evidence remain separate required delivery steps.
