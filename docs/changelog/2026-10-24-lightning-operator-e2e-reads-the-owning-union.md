# The Lightning Operator Browser Check Reads The Owning Union

Since #7884 (06:44 UTC), a member club's Lightning operations page shows its union's games: it resolves the owner with `fn_club_union_context` and calls `fn_lightning_operator_overview` with that owner. `tests/e2e/production-lightning-operator.spec.ts` still asserted the member club's own id, so every post-deploy Client browser verification since then failed on the same line (runs 40081764790 and 40091414733: expected `2a1132b9-...`, received the Midway union `fade0000-...-0001`).

The spec now waits for the page's own `fn_club_union_context` answer and expects the overview to read that owner (`own_union_id`, else `member_union_id`, else the club). No product change.
