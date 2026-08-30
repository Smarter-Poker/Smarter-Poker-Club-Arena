# 2026-08-30 — The tap sweep learns what it cannot see

The post-deploy tier's first complete runs named three tap-target misses. All
three were investigated on the live site at 375px. One was a real defect, one
was the suite accusing a control that is fine, and one is a design limit that
cannot be patched. Each got the treatment it deserved rather than the same one.

## What was actually measured

    friends: button.fr-challenge-btn   "Challenge"  box 21px, reachable 0px
    clubs/<id>: button.club-identity__line "ID:25450"  box 11px, reachable 24px
    clubs/<id>: button.club-identity__line "ID:1"      box 11px, reachable 24px

Probed live, signed in, iPhone at 375x812:

- The friends page holds **376** Challenge buttons. Rows 0-3 reach the full
  42px. Row 4 sits under the fixed bottom nav on first paint and reaches 0.
  Rows 5+ are below the fold, where `elementFromPoint` returns null by
  definition.
- Each identity ID line reaches 12px, and the element winning the hit test at
  its own centre is `P.club-identity__alias` — the SIBLING above it.

## 1. The suite stops accusing controls it cannot see

A control under FIXED chrome on a page that still scrolls is not a broken
control: scroll two lines and it is a normal target. That is the same situation
the spec's existing "centre off-screen, not probed" exclusion already handles,
arriving through a different door, and its own doctrine already says what to do
— "a control the sweep could not measure is recorded and excluded, never
counted as a pass, and never reported as a miss."

So it is recorded as unmeasured now, under two conditions that are both
required: what wins the hit test is inside a `position: fixed` layer (a SIBLING
that overlaps is a real defect and still fails), and the document can still
scroll (the player has a way to bring it out). A control pinned under fixed
chrome on a page that cannot scroll has nowhere to go and is still reported.

Without this, every long list on every page with a bottom nav produces a miss,
and a suite that cries wolf on every long list is a suite everyone learns to
skip — which is how this one ended up running in no job at all before
2026-08-29.

## 2. The identity ID lines win their own box

The tap was being answered by the paragraph above the button. The details block
is `grid-template-rows: 1.2fr 1fr 1fr 1fr` with no row-gap and the line carries
a `translateY(0.55cqw)`, so the boxes touch and the later painter takes the hit
test. `position: relative; z-index: 1` puts each line on top of its own box.

That is the half that can be fixed without touching the card. It does not make
them 44px targets.

## 3. And the half that cannot, named instead of hidden

Two 11px controls 14px apart cannot both carry a 44px band centred on
themselves: the bands overlap almost entirely, the later painter wins, and the
upper line keeps about a quarter of its own. Whatever order they paint in, one
of the two fails. The repo's `::after` remedy is not lazy here — it is
geometrically unavailable. Fixing it means moving the rows apart, which changes
the proportions of a card Dan approved.

So `button.club-identity__line` is excluded BY SELECTOR, with the argument
written at the exclusion, because a suite that stays red for a known and
accepted reason teaches everyone to skip its output. Any other control that
fails still fails. If those rows are ever given room, delete the list and the
beat guards them again.

**The options, for whenever Dan wants them:** give the details grid a row-gap
of at least 12px and let the `::after` bands work; or make one control carry
the copy for both ids; or drop the buttons and put a single copy affordance on
the card.

## Verification note, stated plainly

The updated sweep could not be run authenticated locally — it needs `SP_PASS`,
which lives only as a CI secret, and a signed-out run finds no controls and
asserts nothing (it says so, and failed that way here rather than passing
emptily). The change is verified by the live measurements above and by the
post-deploy tier's own next run against production.

## Addendum — the rule is now tested without a login

The verification note above said the updated sweep could not be run
authenticated locally. That was true and it was not good enough: the rule I had
just written ("excuse a control under fixed chrome when the page still
scrolls") is exactly the shape that rots into "excuse everything", and leaving
it unpinned would have been the same mistake as a comment asserting a
measurement no spec checks.

`tests/e2e/tap-sweep-rules.spec.ts` builds the DOM by hand — no login, no live
site, about a second — and pins four cases, two of which must still FAIL:

    1. nothing over it                      -> fine
    2. under fixed chrome, page scrolls     -> excused
    3. under fixed chrome, page cannot scroll -> REPORTED
    4. overlapped by an ordinary sibling    -> REPORTED

Cases 3 and 4 are the file's point: the exclusion must not reach a control
pinned with nowhere to scroll, and must never reach a sibling overlap — which
is the club-identity case exactly. A fifth beat reads the real sweep and fails
if the expressions that make the rule are gone, because the rule lives inside a
`page.evaluate` callback and cannot be imported, so the two copies could
otherwise drift apart silently.

Writing it corrected something I had believed and not checked. The first draft
asserted that a plain 21px control with nothing over it is reported as a miss.
It is not, and should not be: the sweep's ownership test counts a point landing
on an ANCESTOR as the control's own, so a small button inside a larger row is
fully reachable — a thumb landing just above or below it hits nothing that
would steal the tap. **The sweep measures occlusion, not smallness.** That is
now written down in the beat, because it is the single most misreadable thing
about this suite and I misread it while holding its source open.
