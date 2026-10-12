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

The literal always-raise/pot-every-street case also runs through the real
controller, completed-hand worker observer and a subsequent FAST request.
Its private read frame carries the learned scoped PFR/VPIP and postflop
aggression. The actual FAST computation invokes the widened opponent range
and the 1.2 call-down modifier; its returned action remains legal. This does
not require the horse to call every bet or claim strategy optimality.

Focused checks: 342 tests passed across ten files and the server TypeScript
check passed. This is a local source repair, not a production release.

## Qualification boundary

HorseMind is hashed by Phase 10, Phase 11 and Phase 12. The current Phase 10
PLO4 and Phase 11 PLO5/PLO6/PLO8 generation-one selections admit on the
unchanged source and refuse this modified source as `policy_digest_mismatch`.
FLH's generation-two selection from #6765 also binds the previous HorseMind
source and is explicitly null after integration. Its qualification and
completion hashes remain checked, stale admission refuses the repaired
digest, and the authority-holder regression permits a fresh qualified
generation three without resurrecting a withdrawn generation two.

Their evidence is preserved. All five selections are explicitly null while
the modified source awaits requalification. Tests prove the unselected gates
remain in shadow and retained evidence still refuses the modified digest.
No digest file or admission guard is changed. All Phase 12 selections are
currently null. Phase 13
explicitly excludes HorseMind from its own digest; its nine digests remain
unchanged.

Before integrating this repair, account for the five packs returning to
shadow. Their existing protected-main strength workflows and assemblers
must requalify the exact modified source, with fresh Phase 11 and FLH natural
completion records and new protected selection generations. Historical
opponent counts are not rewritten or backfilled by this source change. The
existing locked workloads total 753 shards and 9,116,928 paired hands; no
held-out seed or experimental design changes.

## Completed-hand all-in classification

The controller can record `all_in` for a whole-stack call or a short raise.
The basic model and range reader already require `isFullRaise === true`
for aggressive all-in reads, but the completed-hand model treated every
all-in as aggression. A real accepted raise to six followed by a six-chip
all-in call invented a three-bet opportunity. The same mismatch could
replace the preflop aggressor and count a river call as a value bet.

One shared predicate now preserves the existing basic/range semantics in
the deep reads. Full-raise all-ins still count; calls and short all-ins do
not fabricate full-raise opportunities. A full aggressive flop shove also
counts as a c-bet when made by the preflop aggressor. Real-controller
regressions cover duplicate worker observations, calls, short/full raises,
preflop aggressor ownership, c-bets and separate river shove/call reads.

The literal FAST case now exceeds the forty-hand scoped-read threshold
and contrasts its scoped 100% PFR with a pooled prior from another variant.
It proves the actual range accessor chooses the learned scoped read,
not merely that the private frame contains scoped counters.
