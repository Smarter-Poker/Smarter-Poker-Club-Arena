# 2026-10-12 - The Diamond Arena matches the Club Arena (phase 1: look and table fixes)

Dan, 2026-10-12, with screenshots of the Diamond Arena lobby and a 9-max
Diamond Arena table on a phone:

1. "ALL OF THE WHITE OF THE DIAMOND ARENA BACKGROUND SHOULD BE BLACK AND LOOK
   JUST LIKE THE CLUB ARENA."
2. "THE FOOTER NEEDS THE IMAGES LIKE THE CLUB ARENA, NOT JUST WORDS."
3. "THE BUTTON IS NOT CORRECT OR IN THE RIGHT LOCATION ON THE TABLE" and
   "BUTTON JUST RANDOMLY IN THE MIDDLE OF THE TABLE".
4. "THERE IS NO 'I'M BACK' BUTTON TO CLICK FOR THE DIAMOND ARENA WHEN YOU ARE
   SITTING OUT."
5. "'DIAMOND ARENA' AND HAND NUMBER SHOULD BE LARGER AS WELL."

Must-move games and BBJ / Mini BBJ for the Diamond Arena are later phases of
the same request and are not in this change.

## 1. The light room is retired

2026-09-11's "DIAMOND ARENA SHOULD BE WHITE, OR LIGHT SCHEMA" was implemented
as a third `<html>` attribute, `data-arena-scheme="light"`, written by
`src/lib/arenaScheme.ts` from `App.tsx` and selected by a token block in
`club-engine.css` and a surface block in `ClubHomePage.css`. The latest owner
instruction reverses it, so all of it is removed: the module, the effect, both
CSS blocks and the law that pinned the light room
(`tests/diamond-arena-is-the-light-room.law.test.ts`). The body's black ground
is now the only ground. `tests/the-diamond-arena-is-black-like-the-club-arena.law.test.ts`
refuses the attribute, its writer or a keyed block coming back from a stale
branch. The Diamond route and stale-client specs now assert the attribute is
absent.

## 2. The Diamond footer has painted doors

`public/images/club-footer/diamond-arena-footer-v2.webp` is the v1 derived
well with six doors painted into it, icon over word, in six equal cells (311
of the frame's 1866 master pixels each), in the chip master's own white Roboto
caps (Roboto 400 at 28px reproduces the master's PLAYERS label exactly: 117 x
20px). Sources:

- Players, Stats: the chip footer master's own icons, cut with their alpha.
- Lobby: the master's Cashier chip with its word lifted off the face (rim
  rebuilt by a 45-degree rotation of the chip onto the band the word crossed,
  face re-synthesised from its own radial profile, the spade re-seated in the
  centre).
- Hand History: two fanned cards (K and A of spades) in the brushed silver
  and gunmetal of the footer's icons, built from the app's own card faces.
- Messages: the header's silver chat bubble with blue lights, keyed off black.
- Wallet: the approved silver wallet (header v4).

`DiamondBottomNav` no longer prints its labels; like `ClubBottomNav` it lays
six full-cell targets over the art with visually hidden names. v1 stays in
`public/` for clients still holding the previous bundle.

## 3. The dealer button stays beside its own seat

Reproduced exactly: on a phone, the 9-max ring's middle side seats (x 8 and
x 92, y 58) put the puck at x 44 / x 56, y 51 - the middle of the felt.
`dealerButtonPositionClearOfSeat` first retreats the puck toward the centre to
clear the seat's plate, and that retreat could walk 30% of the table. On a
phone those seats sit level with the felt printing, so every step stood in the
masthead keep-out until the puck had climbed past it. The upper side seats on
both rings did the same thing more mildly (x 30 / x 70). The retreat is now
capped at 8% (`RETREAT_MAX_WIDTH_PCT`); when that cannot clear the plate the
puck takes the nearest clear spot within 24% of its own seat
(`NEIGHBOURHOOD_WIDTH_PCT`), which is above or below the plate, before the old
swing is ever tried. Measured against the wider player plates that landed the
same day (#6729). Every ring from 2-
to 9-max at 375, 430 and desktop widths now lands within a short nudge of its
rail position and nearer its own player than any other, pinned by
`tests/the-dealer-button-stays-beside-its-seat.law.test.ts` (which fails on
the old 30% walk). This geometry serves both arenas.

## 4. I'm Back is never shadowed

A hero who is sitting out is not in the current hand's player list. The footer
chain checks "hero not in the player list" for its Seat Reserved bar BEFORE it
checks the sitting-out bar, so the player read "Seat Reserved, You'll Be Dealt
In Next Hand" while their seat read SITTING OUT, with no way back. The
reserved branch now stands aside when the hero's seat row says they are
sitting out (`heroIsSittingOut`), and the sitting-out bar with I'm Back
renders. The placeholder seat drawn for a hero outside the hand list printed
0.00 over a seat holding 3,632; the seat poll now reads `stack` and the
placeholder prints it. `tests/im-back-is-never-shadowed.law.test.ts`.

## 5. The club line and hand number are larger

On every table (both arenas share the masthead): the club line 0.48rem to
0.66rem (0.6rem at 380px and below), the hand number 0.44rem to 0.58rem (0.54rem)
and brighter. `FELT_TEXT_BAND.lineHeightPx` grew from 11 to 14 so the dealer
button keeps clear of the taller printing; the chip-rail and seat-plate
geometry tests still pass.

## Continuation checkpoint: seated reloads (Codex 01a13096, 2026-10-12)

Scope: finish the listed phase-1 UI and session-recap fixes. Must-move and
BBJ/Mini BBJ remain separate later phases; their acceptance details were not
present in the supplied handoff. The original PR #6732 is merged at
`a09c5f6967daf0dd8234c6bd91b747727f29095c`. Its source is included in the
published client `514f1116886208d0f36eaee61db7a434351f3d74`, publisher
`38259327997` (terminal success), verified at both required build-info URLs.

Recovery found migration `20261012062409` already installed under its exact
name. Both function bodies match the merged migration: baseline source MD5
`1e9269b437fbce253d2c31e4690d77a1`, facts source MD5
`2d544bf1d32c7fea07481ea7202f17cd`. Both remain stable SECURITY DEFINER,
owned by postgres, search_path public/pg_temp, authenticated/service_role
execution only (anon denied). No migration was replayed. Read-only custody
and hand-history evidence confirms the reported session: 4,000 reserved,
1,376 returned, 20 hands, 33.67 minutes, result -2,624.

The remaining connected defect was at the client trigger: restoration was
inside `mappedHero && mappedHero.stack > 0`, then inside the zero-buy-in seed.
A cash player reloading while sitting out is absent from the hand roster;
a busted seat has no positive stack. Neither asked for the recorded session.
Restoration now follows the occupied cash seat and account/table identity,
independent of hand participation or stack. Cleanup and identity checks reject
late answers after departure or account/table changes. Existing server reads,
counter merge rules and financial transactions are preserved.

Regression: the new occupied-seat gate check failed on the prior source;
after the repair the exact effect callback restores 4,000/20 hands/the original
start for absent-hand seats at stacks 1,376 and 0, and ignores a delayed answer
after cleanup. A delayed-roster regression also failed before the correction
(5,076 instead of 4,100); the snapshot placeholder is now excluded while an
actual 100 top-up is retained. Focused table laws and recap tests pass (43 tests before adding
the three effect behavior cases; final recap file 9 tests). App TypeScript
compilation passes. Required exact-candidate hook/CI, protected merge,
publication and final affected live proof remain pending for this follow-up.

Live observation of the existing release: black lobby, six loaded painted
footer doors, larger felt labels, dealer puck beside its seat at desktop and
375px, document clientWidth=scrollWidth=375. No personal gameplay or financial
probe was performed. Live-table interoperability job in run `38260238523`
passed with actual-hand/reconnect cases and isolated-account cleanup. Its
client browser job failed specifically at Cashier database/browser checks;
that broad job is not represented as passed and is outside this UI repair.

Owner policies read in full through the canonical reader at
2026-10-12T14:55:28.290Z, version 2.9, manifest
`a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
Canonical paths: /Users/smarter.poker/Documents/{AGENTS.md,
AGENT-OPERATING-LAW.md,AGENT-HARDENING-STANDARD.md,AGENT-REFERENCE-INDEX.md}.
Their hashes respectively: b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349,
a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5,
d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e,
adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555.
Portable canonical comparison passed; repository AGENTS/CLAUDE/playbook,
PUBLISHING and deploy-paths read. Current checkout instructions match the
canonical clone. SSD disk7s4 mounted with space. Owner of this follow-up is
Codex 01a13096 on branch `fix/diamond-recap-seated-reload-01a13096`, base
`8ab126a4ab2a64bf0ee578a119698da2ca92bcb5`, private checkout under
/Volumes/SmarterWork/agent-work/diamond-arena-ui-resume-01a13096/repo.

Final runtime source build passed at `4792e55d50381e32222d21c8480f08b64510d447`
with behind-main=0 after integrating protected main. The first completed
pre-push refused one stale structural test in sessionBuyInTotal.test.ts:
it required the removed per-table latch. All other selected tests passed
(3,186 source contracts and 556 related tests). Its contract is updated to
pin the occupied account/table key, stable effect dependencies, late-answer
identity/cleanup guard and unchanged baseline application. This updates the
mechanism without removing the once-per-session or stale-answer protection.
The follow-up submission retains the full normal hook and required CI.
