# The Lightning Operator Certificate Holds Admin On The Owning Union

After #7884 a member club's Lightning operations page reads its union's games, and `fn_lightning_operator_overview` authorizes admins of the club that owns them (`fn_lightning_operator_may` -> `fn_ca_can_review_integrity`). The post-deploy certification account was a zero-balance admin of the member club (Deep Stack Society) only, so after #7904 aligned the expected owner the overview answered `ok: false` (run 40105530522) and Client browser verification stayed red.

Dan 2026-10-24 chose "Admin on Midway": `prepareProductionE2ELightningMembership` now also prepares the same reserved, zero-balance, public-join-then-admin membership on the member club's union house club, with the same exact-shape reuse refusal. A standalone club still needs only its own membership. The account stays in the reserved namespace and is retired by the existing cleanup.

Proof on production in one rolled-back transaction: a member-club admin joining Midway lands `pending`, is promoted to admin, `fn_lightning_operator_may(Midway)` is true and the overview answers `ok` with 69 clusters, 52 of them the drained Must Move / worker-off candidate the spec requires. Nothing committed.
