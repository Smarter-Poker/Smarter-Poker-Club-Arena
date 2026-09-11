# scripts/ci/rehearse-d1-tournament-ruling.py

A privileged ruling that invalidates a repair-created knockout generation keeps
both candidate identities and accepted-hand witnesses, seals their before-images
and the player's before-image, and commits the invalidation, original-bust
restoration and real elimination timestamp together. Ordinary engine/player
roles cannot create that authority. Audited evidence cannot be rewritten,
deleted or truncated; either adjudicated candidate cannot be revived or have its
identity rewritten. Latest-generation readers retain the invalidated barrier.
Normal final settlement selects the restored eliminated witness and preserves
all prior financial evidence. Native PG17 tests in
`scripts/ci/rehearsals/d1/test-invalidations.py` prove refusals and atomic closure;
`verify-local.py` proves all final positions, payouts, conservation and replay.
