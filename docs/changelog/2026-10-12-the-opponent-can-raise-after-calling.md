# An opponent can raise after calling

HorseMind counted preflop raises only while recording the first voluntary
action of the hand. An opponent who called or limped and then raised was
counted as playing the hand but never raising it. Thirty real HandController
limp-reraise hands delivered through the worker's actual completed-hand
observer reproduced 30 hands, 30 VPIP and zero PFR.

VPIP and PFR now have separate once-per-hand flags. The later raise counts,
while repeated raises and duplicate completed-hand observations retain one
PFR observation per hand. The same observation delta updates the scoped
model. The regression covers ordinary opens and limp-reraises, duplicate
worker delivery, the pooled/scoped counts and the actual range reader's
confidence-weighted widening.

Focused checks: 197 tests passed across eight files and the server TypeScript
check passed. This is a local source repair, not a production release.

## Qualification boundary

HorseMind is hashed by Phase 10, Phase 11 and Phase 12. The current Phase 10
PLO4 and Phase 11 PLO5/PLO6/PLO8 generation-one selections admit on the
unchanged source and refuse this modified source as `policy_digest_mismatch`.
Their evidence is preserved. Those four selections are explicitly null while
the modified source awaits requalification. Tests prove the unselected gates
remain in shadow and retained evidence still refuses the modified digest.
No digest file or admission guard is changed. All Phase 12 selections are
currently null. Phase 13
explicitly excludes HorseMind from its own digest; its nine digests remain
unchanged.

Before integrating this repair, account for the four packs returning to
shadow. Their existing protected-main strength workflows and assemblers
must requalify the exact modified source, with fresh Phase 11 natural
completion records and new protected selection generations. Historical
opponent counts are not rewritten or backfilled by this source change.
