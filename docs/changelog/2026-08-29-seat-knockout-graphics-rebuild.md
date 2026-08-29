# Seat knockout — two branded gloves, a flurry, and a sound rebuilt from measurements

2026-08-29. Follows PR #1687 (`feat(ca): the knockout happens at the seat,
PokerBros 1:1`), which landed the architecture and the timing.

Three rounds of Dan in one day:

> THATS A START, GRAPHICS AND ANIMATION LOOKS LIKE SHIT THOUGH AND NEEDS TO BE
> UPGRADED BADLY!

> I'VE ATTACHED A "PREMIUM" LEFT AND RIGHT BOXING GLOVE THAT YOU SHOULD BE
> USING... PLUS A VIDEO OF HOW IT SHOULD LOOK WITH TWO GLOVES.

> THE ANIMATIONS SHOULD BE LARGER, DURING A "KO" IN A TOURNAMENT, THIS VIDEO IS
> FROM A "THROW ABLE" IN THE CASH GAME, BUT SAME IDEA AND PRINCIPLE.

**The architecture is untouched.** Still seat-anchored, still an array of live
hits rather than a queue, still a sibling of the seat ring so the stamp
outlives the chair, still `pointer-events: none`, still coalescing the bounty
on the stamp beat. Impact stays at **460ms** and the stamp at **930ms** —
those are the numbers TablePage's bounty coalescing and the law tests are built
on, and the flurry fits _inside_ the window that already existed rather than
moving them to suit a nicer punch rhythm.

## The gloves are Dan's art now

Two branded renders ship as `public/images/knockout/glove-{left,right}.webp`,
512px at q86 (~58KB each), resolved through `mediaUrl()` like every other large
static asset so they can be flipped to the CDN with `VITE_MEDIA_BASE`.

The hand-drawn SVG glove is deleted. Its whole reason for existing was stated
in the first cut's header — _"a lazily-fetched PNG cannot promise the FIRST
knockout of a session animates"_ — which is a real constraint with a better
answer than drawing a boxing glove by hand: **preload at module scope**.
TablePage imports this module, so both decodes start when a table opens,
minutes before anyone busts.

Which glove is which matters and is not obvious: both renders are pre-rotated
along their own diagonal, so the CSS translates along that same line and barely
rotates them (the lighting is baked in; spinning them fights the art). The fist
sits at **(0.658, 0.207)** inside the left render and **(0.292, 0.226)** inside
the right — measured off each alpha channel by finding the red mass on the far
side of the gold cuff patch. The negative margins are those fractions times the
glove width, so it is _the fist_ that lands on the seat, not the image centre.
Replace the art and you must re-measure those two points.

## The flurry, measured

`KO KNOCKOUT.MOV` is a cash-game throwable, so the **choreography** transfers
and the scale does not. Read frame by frame at 30fps and then confirmed against
its own audio track by onset detection — seven landings across 0.9s, 64–272ms
apart. Punches alternate, each glove arrives on its own diagonal, every landing
throws a small _warm_ burst at the contact point, and the head snaps each time.

Ours, inside the existing window:

|            |                                           |
| ---------- | ----------------------------------------- |
| t0         | right glove enters from lower right       |
| **+180ms** | it lands — warm burst, seat snaps         |
| **+320ms** | left glove lands — warm burst, seat snaps |
| **+460ms** | **both** land together — the white star   |
| +930ms     | the KO stamp slams on, the bounty ships   |
| +2400ms    | the stamp fades over an empty chair       |

Only the two-fisted finish blows out white; the two jabs are orange-gold, which
is what the capture shows and what stops three landings reading as one drum
roll. Both jab bursts are drawn by **one** element that flashes twice — between
them it is fully transparent, so the tween across the gap is invisible.

The landings are deliberately **off-centre**. A fist parked on the seat centre
hides the whole player behind 0.86 units of red leather and you cannot see who
is being knocked out; each punch lands about a fifth of a unit short, on the
near edge. The bursts are drawn _after_ the gloves so each one blows out over
the glove that caused it.

## Two real bugs found on the way

**1. `skoSeatFlinch` used `transform:`, which would have stomped the seat's own
scale.** `.seat` states carry `transform: scale(...)` for hero / active /
winner. A transform keyframe on the same element replaces that scale for the
whole flinch — three times per knockout, on the seat everyone is looking at. It
uses the individual `translate:` and `rotate:` properties now, which compose on
top. `throwable-seat-flinch` learned this first and says so in
`ThrowAnimation.css`; I had to learn it twice.

**2. `.sko` was still clipping what it draws.** It was 1.9 × 1.25 units with
`contain: layout paint size`, and paint containment clips to the padding box —
so the top and bottom of the star had been cut off at every seat and every
breakpoint since it shipped, invisibly, because the shape was symmetric enough
to look intentional. It is 3.6 × 4.4 now, sized by the binding constraint (a
glove at its exit position reaches 2.1 units below the seat centre). Paint
containment is kept; the box just has to be big enough to earn it.

A third, in the darkroom rather than the product, is worth recording because it
looked exactly like a product bug: the harness styled `.cell img`, which is
specificity (0,1,1), and `.sko__glove` is (0,1,0) — so a bare element-type
selector in the test harness silently outranked the component and stretched
Dan's gloves to fill the whole cell.

## Sound

**Dan asked whether I can hear and record the sound effects. I cannot hear
them. I can measure them, and did.** Onset detection plus a short-time Fourier
transform over both captures gave:

- seven onsets, 64–272ms apart, decays of **46–186ms** — every hit is short;
- two flavours: a body thump whose strongest partials sit at **86, 129 and
  172Hz**, and a brighter crack peaking at **1.4kHz** or **3.7kHz**;
- band energy 26% in 120–400Hz, 22% in 400Hz–1.2kHz, 35% in 1.2–4kHz, only 8%
  above 4kHz. Leather and body, not cymbal.

`playKnockoutSwing` and `playKnockoutImpact` are replaced by one
**`playKnockoutFlurry`** cue that schedules the whole combination on the
AudioContext clock — not four `setTimeout`s, because a main thread busy
re-laying-out a table that just lost a seat drifts a timer by tens of
milliseconds and the 50ms priority window then eats the late arrival. It takes
the player's Animation Speed and multiplies every offset by it, so the audio
and the CSS stretch together.

### The "K.O." voice

Dan asked for the human "K.O." from the original capture. Two things worth
knowing.

**Where it actually is.** The whole 51.9s file contains exactly **two**
strongly-voiced segments (periodicity > 0.45, F0 75–350Hz, centroid < 2600Hz),
and they are the two knockouts: 2.39–2.62s and 49.27–49.54s. Both are the same
recording. Measured: **F0 falls 342Hz → 157Hz across ~300ms** (about 1.1
octaves — that fall _is_ what the ear reads as a called knockout), periodicity
0.75–0.82 so strongly voiced and close-mic'd, centroid 1.7–2.0kHz so warm with
no sibilance, first formant ~640Hz drifting to ~215Hz and second ~1000Hz
drifting to ~640Hz, which is the vowel moving from the "ay" of K to the "oh" of
O. **It lands on the IMPACT, not on the stamp** — t0+420ms to t0+650ms.

**Why it is synthesised and not sampled.** That recording is PokerBros' audio
asset. Extracting it and shipping it inside Smarter.Poker would be copying
someone else's sound recording, so it is not on the table however good it
sounds. `scheduleKnockoutCall` is a source-and-formant approximation built to
the numbers above, and it says so in its own comment. **To replace it with a
real voice:** record 300ms, falling, close-mic'd, no reverb, to that contour;
drop it in as `public/images/knockout/ko-call.webm`; point the code at it. The
synth stays as the fallback. That is a two-minute recording and it will be
better than the reference, because it can be _your_ voice.

## Everything else from the first pass, still true

- **The star is one irregular path**, not twelve `<span>` rays at exact 30°
  increments — twelve even spokes cannot be irregular. Fifteen needles, tips
  34–105 against valleys of 10–16, clustered rather than evenly spaced. Two
  dead ends are recorded in the CSS so nobody walks back into them: valleys of
  13–23 photograph as a **snowflake**, valleys of 22–34 as a **sheriff's
  badge**.
- **The core is white** — measured (251, 252, 255). The original went gold by
  26% of the radius and photographed as a cartoon sun.
- **The stamp is SVG glyph paths at #FC0000**, not `font-family: 'Arial
Black'`, which does not exist on Android — the one element carrying
  _information_ rather than drama was the one rendering differently per device.
- **Gradient ids are instance-scoped** via `useId()`. `<defs>` ids are global
  to the document and a multi-table view mounts one layer per table.
- **No `will-change` anywhere.** Eight simultaneous knockouts is 240 concurrent
  animations; a permanently-promoted layer each is a GPU memory problem, and
  Chrome promotes a _running_ transform animation on its own.

## The bounty award: it already ships

Dan, on seeing the harness: _"LAST THING YOU HAVE TO DO IS ADD THE BOUNTY AWARD
ANIMATION. WHERE THE BOUNTY AMOUNT(S) FLY FROM THE VILLAIN THAT JUST BUSTED AND
LAND ON THE WINNER OF THE HAND WITH A +XXX CHIPS ADDED TO THE WINNER."_

**That is already built and shipped** — it landed with PR #1687 and nothing here
changed it. It was missing from the _harness_, not from the product, because
the harness renders only `SeatKnockout` and this lives in `TablePage`:

- `bountyAwardAccRef` sums every bounty a knocker takes in one hand and fires
  once, on `SKO_STAMP_AT_MS * getAnimationSpeed()` — the same beat as the KO
  stamp, so the money leaves as the stamp lands;
- `createPotToWinnerEvent` flies one chip stream **per busted head**, from that
  villain's seat to the winner's chair (3–8 sprites, 40ms apart);
- `spawnPotWinFloat` rides ONE `+2,120` along the same path in the measured
  PokerBros yellow (`#ffe94a`), parks it above the winner's avatar, holds, then
  rises and fades over 2.2s;
- a victim whose seat this client never saw falls back to the pot anchor — the
  money still visibly arrives, it just has no chair to leave;
- the hero gets `playBountyCollected()`.

Worth knowing: the winner then gets a **second** `+N` from `SeatSlot`'s own
`stackDelta`, which fires automatically whenever a seated player's stack
changes. Those are two different statements — _the money is arriving_ and _your
stack went up_ — and they are both correct, but they will read as two numbers.
If that is one too many, the stack delta is the one to suppress for a bounty.

The harness now reproduces the whole sequence so it can be watched end to end,
using the REAL `.pot-win-float` rule read out of `TablePage.css` at build time
rather than a lookalike. The chip sprites there ARE a stand-in — the real ones
are DOM objects owned by TablePage — and the page says so.

## Hearing it

The playback page can now play the flurry: a faithful port of
`playKnockoutFlurry` in vanilla Web Audio, behind a **Sound** button because
browsers refuse to start audio without a user gesture. Every number in it is
the number the service uses, and every number in the service was measured off
Dan's capture.

## Which events it fires in, verified rather than assumed

Dan: _"PUSH AND PUBLISH THE NEW KNOCKOUT FOR THE MTT'S INSIDE OF BOUNTY, PKO AND
MYSTERY BOUNTY EVENTS."_

Already covered, and checked at the source rather than taken on trust.
`TournamentManagerEliminations` broadcasts **`bounty_collected` on every bounty
elimination regardless of mode** — `fn_collect_bounty` returns `pko`,
`mystery_pre` or `regular`, and all three take that one path. TablePage's
knockout branch is the `else` of `mystery_bounty_revealed`, which is a
_separate and later_ broadcast carrying the chest reveal. So a Mystery Bounty
knockout gets the flurry when the player busts and the chest when the award
settles, which is the right order and already what happens.

## The boxing-glove throwable is the same animation now

Dan: _"THIS ANIMATION SHOULD ALSO REPLACE THE BOXING GLOVE ANIMATION INSIDE THE
CLUB ARENA THROWABLE. SAME ANIMATION, SAME SOUND EFFECTS (MINUS THE K.O. AT THE
END)."_

The flurry is split out of `SeatKnockoutHitView` into an exported
**`KnockoutFlurry`** — position-agnostic, timer-free, sound-free. Everything
positional stays on the parent: the knockout places it from the seat ring's
hero-rotated percentages, `ThrowAnimation` places it in pixels at the target it
had already computed. **One implementation, two callers** — a second copy would
drift the first time either was tuned, and every fix would have to be made
twice.

Minus the knockout, in four places, because nobody has been eliminated:

- **no stamp**, and no stamp flash or shockwave (`showStamp={false}`) — KO on a
  seat that is still occupied is a lie;
- **no called "K.O."** and no stamp tick (`withCall: false` on
  `playKnockoutFlurry`);
- **no `IMPACT_CAPTION`** — that caption was literally the word K.O.;
- **no spoken line** in `ThrowableVoice`.

Two details that would have been bugs:

1. `--sko-unit` is passed **inline from the throwable's own impact size**. The
   knockout layer lives inside the seat ring where `--seat-avatar-base` is
   retuned per breakpoint; this wrapper does not, so it would have inherited
   the `:root` 84px and drawn a desktop-sized flurry on a phone.
2. `IMPACT_MS.boxing_glove` went 900 → 1500. The flurry is three landings and a
   star; 900 cut it off mid-punch.

## How it was verified

`scripts/dev/preview-seat-knockout.mjs` is a proper darkroom now: fifteen beats
with the capture's own frame beside ours, eight simultaneous knockouts, the four
`--seat-avatar-base` rungs (56 / 66 / 84 / 104), and a reduced-motion pass. It
reads the star paths, the spark table and the stamp glyphs **out of the .tsx**
and inlines the shipping glove renders as data URIs, so it cannot photograph art
that no longer ships. It always writes a self-contained `harness.html` and only
_optionally_ drives Playwright, because a sandboxed agent usually cannot launch
a browser but can always write a file.

Six real defects were caught by that comparison and nothing else would have
caught them: the star arrived 60ms late; the felt light was a huge olive disc;
the star was three times too wide; the stamp took until +1106ms to settle; the
gloves covered the entire player; and the flinch stomped the seat's transform.

**Performance, measured rather than assumed.** Chrome, eight knockouts, 240
animations running at once: 174 frames, mean 16.67ms, p50 16.7ms, p95 17.5ms,
max 17.7ms. A clean 60fps.

## Tests moved with the mechanisms, in this commit

Per the animation law — replace a mechanism, move its pin in the same commit.

- `tests/e2e/live-animations.spec.ts` — `skoGloveStrike` (one glove, one
  strike) is gone; `skoPunchRight`, `skoPunchLeft` and `skoFlurryHit` carry the
  flurry, and `skoSeatFlinch` is pinned at 200ms.
- `tests/components/BountyAnimations.test.tsx` — the two audio calls become one
  `playKnockoutFlurry`, asserted on its beat table rather than on call counts.
- `tests/animations-always-play.law.test.ts` — new pins: the gloves come from
  `mediaUrl()` and are preloaded; the fist anchors are not symmetric; the seat
  flinch fires once per landing, is scoped to this table, and uses
  `translate:`/`rotate:` rather than `transform:`.

## Honest gaps

1. **Still never seen on a real table.** Every visual judgement came from the
   darkroom against a mock felt.
2. **The 60fps number is desktop**, at the 84px seat token — not a 375px phone.
3. **The KO call is a synth, not a voice.** Deliberate, and one recording away
   from being fixed properly.
4. **`z-index: 615` is still reasoned, not observed.** Inherited from #1687.
5. **The `isHero` warmer bloom is still a deliberate deviation** from the
   reference, which draws hero and villain knockouts identically.
