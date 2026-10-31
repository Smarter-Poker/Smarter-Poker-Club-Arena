# Isolated tournament player UI acceptance

Scope: actual Call Any, Call Bet Amount, paid rebuy automatic chair return,
and persisted finish reports for MTT, SPIN and SNG. Paid rebuy acceptance uses
the supported MTT venue; it does not add rebuy eligibility to short formats.
This is qualification
tooling, not an engine activation or permission to play production chips.

Existing representative actors use engine HTTP input and existing native
qualification covers a two-player cash cohort. Neither establishes these
tournament browser flows. The new modules prepare actual page button input,
sanitized HTTP/wire evidence and fixed read-only native facts for the existing
isolated fixture. They must not count mock contracts as connected acceptance.

The full-schema readiness contract, ordinary actor authentication, immutable
runtime/engine/web/schema inputs, independent observer identity, private DB
custody and final resource cleanup remain required. No readiness flag, grant,
production URL fallback, generic SQL transport or release route is added.

The opt-in existing controller mode now creates three additional real GoTrue
actors after the unchanged cash seed. Its existing MFA owner funds them
through the canonical club bank, creates/registers the three tournaments and
requests the MTT start. Only the engine creates live chairs and claims RUNNING.
The ordinary browser clicks every played action. Native facts bind the exact
cohort/actor/token behind the existing private read-only socket. A retained
zero-stack busted chair is valid; a second active chair or positive busted
stack fails. Finish reports compare every displayed rank and money cell with
the canonical persisted standings, then repeat the read on a fresh document.

The original fixture and candidate cleanup remain mandatory. The opt-in
receipt explicitly has product_certificate:false and cannot replace a product
or release certificate. It does not publish or activate an engine.

Validation: four focused negative contracts and 100 affected existing runtime
and financial observer contracts pass. Changed JavaScript and Python syntax
pass. Full-schema connected execution remains unverified pending an admitted
immutable runtime and exact engine/web/schema input tuple. No live pass,
protected delivery or publication is claimed by these contract results.

## Native control dependency closure

Native CI41218460465 built the image but refused observation bridge startup.
The closed smoke helper list in `smoke-image.sh` and the corresponding source
hash inventory in `ci/fixture-smoke.py` still contained only the original three
helpers; the protocol's new `tournament-player-observations.mjs` import was
missing from that isolated mount. All five native cleanup observations passed.

An actual isolated staging/import regression reproduces ERR_MODULE_NOT_FOUND
before repair. Add only that exact reviewed fourth helper to both closed
allowlists, preserving read-only committed bytes, source hashes, separate
identity and the container/network/image cleanup. A second assertion requires
the native source-hash inventory to equal the actual staged helper list.
The native retry remains required after this source correction; no application
qualification or previously failed native result is represented as passing.

## Normal NLH browser all-in input

The first driver selected only `.action-btn--allin` in its rebuy/finish
phases. Actual ActionPanel renders that main button only when a stack cannot
make a normal raise; ordinary NLH instead requires opening the raise panel
and clicking its immediate `.raise-preset--allin` control. The driver could
therefore keep checking and never create its required bust or finish.

Use one shared NLH browser-input helper for the actual enabled/visible main
All In or Raise-panel All In paths. Retain legal Call/Check fallback and
recheck the current turn before every click. Return true only after actual
game input, so the driver records an acted turn after successful submission,
never after merely opening a panel. Focused regression uses the real rendered
ActionPanel with existing component facilities; it is not runtime acceptance.
After a verified paid rebuy, subsequent inputs use the exact destination table
already proved by the automatic URL transition, native receipt and occupied
hero chair, including a legitimate return onto another tournament table.
