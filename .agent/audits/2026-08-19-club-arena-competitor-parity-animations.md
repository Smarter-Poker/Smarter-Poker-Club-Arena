# Club Arena — Competitor Animation Parity + Improvement Pass (2026-08-19, session 2)

Follow-up to `2026-08-19-club-arena-animation-sound-audit.md`. Dan asked to
(1) verify the morning's fixes are live, (2) deep-dive ClubGG / PokerBros /
PokerStars for any animation we lack, build the gaps, and (3) improve every
existing animation one by one.

## 1. Verification of the morning session

- Club Arena `origin/main` head was `703c92c52` (the animation-audit commit).
- Production `smarter.poker/hub/club-arena/index.html` referenced
  `index-Kba-B41U-v6.js` — the bundle built from that commit (fetched live,
  200). `/api/health` healthy; engine dealing ~190 hands/min.
- Engine deploy had the documented restart-dip signature (18:29 UTC).

## 2. Competitor research → gap list

Catalogued from GGPoker/ClubGG (Card Squeeze, River Squeeze, Rabbit Hunt,
Splash, all-in equity, SnapCam/emotes), PokerBros (avatars/emotes, effects
toggles, themes), PokerStars (Throwables, emojis, animation toggles).

Already present in Club Arena: throwables, emoji reactions, insurance (EV
equivalent), RABBIT HUNT (server event + button + reveal — shipped
previously), all-in equity %, bomb-pot + BBJ celebrations, stage labels,
winner celebrations, table/deck themes, animation-speed control.

Real gaps found and BUILT this session (`Smarter-Poker-Club-Arena`
@ `6b96469fe`):

1. **Card Squeeze** (GG's marquee feature; nothing like it existed):
   - `user_table_settings.card_squeeze` (migration applied to prod via MCP,
     file in `supabase/migrations/`), default OFF, toggle in Table Settings.
   - Hero cards deal face down; drag up peels the back from its top edge,
     tracking the finger via `--squeeze-progress`; release past 55% pops
     them open (paper-flick sound + haptic); tap bounces a teaching hint;
     double-tap or Enter opens instantly. Auto-opens at showdown / all-in /
     winner / muck. Show-card picks disabled while face down.
2. **Table-level ALL IN banner** — slam-in text + expanding shockwave ring
   on the first equity broadcast (the moment the runout locks), for players
   and observers. Per-seat badge already existed; the table moment didn't.
3. **Missing sounds**: shuffle riffle at hand start; tournament level-up
   fanfare (banner was silent); dealer-button felt tock timed to land with
   the 600ms CSS slide; card-squeeze flick; Show/Muck modal sounds.

Deliberately NOT built: server-interactive board squeeze (GG's river
squeeze) — would require the paced runout to block on a client gesture;
the 1.4s/street server pacing already owns that drama. Pot-splash paid
emote — social/monetization feature, not an animation gap.

## 3. Improvement pass (every animation, 1 by 1)

- **New `src/utils/animationSpeed.ts`** — `getAnimationSpeed()` +
  `prefersReducedMotion()`. Every JS class-removal window now scales with
  `--animation-speed` exactly like the keyframes it gates: seat deal (700),
  fold (500), showdown flip (600), all-in shake (400), chip collect (700),
  pot push (700), board newly-dealt window (1400). CSS `cpSlideIn`,
  `cpCollect`, `pdCollect` now multiply by the var too.
- **DealAnimation**: JS picks the flight duration (320/280/250 by viewport,
  × speed) and writes `--da-flight-duration` inline — the CSS breakpoints
  and the JS cleanup timer can never disagree again. Stagger scales with
  speed. Per-card deal sounds gated by `playSounds` (background multi-table
  tabs stay silent, #175). Double new-hand chime removed: the page owns
  shuffle + chime, the component owns per-card slides, with a single-slide
  fallback when card_slide is off.
- **ChipAnimation / ParticleSystem / ConfettiCanvas**: rAF loops now honor
  `prefers-reduced-motion` (chips land instantly, particles complete
  immediately) — CSS media queries cannot reach rAF, so reduced-motion
  users had chips flying over a frozen table.
- **TableMenu**: no longer constructs a new `AudioContext` per open
  (Safari caps ~6 per page — a long session could exhaust them and silence
  the table). Routed through SoundService.
- **Equity badge**: mini white equity bar under the percentage.
- **Board reveal**: `will-change` layer promotion on flop/turn/river cards
  (rotateY was rasterizing mid-flip on mobile GPUs).
- **Dead code deleted** (~1,800 lines net): `useActionSequencer.ts` (full
  sequencer, zero consumers), `lib/animations.ts` (framer presets, zero
  importers), `styles/ChipAnimations.css` + `components/table/
CardAnimations.css` (two whole keyframe libraries with zero TSX
  consumers), TablePage's dead imports (PremiumCard, PlayerCard,
  HoleCardReveal, createChipToPotEvent) and the dead
  `triggerChipAnimation` + ref (still carried the pre-2026-08-04 viewport
  math and the wrong pot target).

## 4. Verification

- `tsc --noEmit` clean; production `vite build` clean.
- **1947/1947 client tests pass** (160 files, run on the host).
- No server changes this session (yesterday's engine work untouched).

## 5. Deploy mechanics

- Local commit with explicit paths (private GIT_INDEX_FILE) →
  cherry-picked onto `origin/main` in a host worktree → pushed
  (`03851f8ab..6b96469fe`). Applied cleanly; the concurrent agent's
  in-progress files (HomePage/lobby/club-modals) were never touched.
- The CA-push CI then rebuilds `public/hub/club-arena/` in World Hub
  ("chore(club-arena): sync build <sha>" by github-actions) → Vercel.

## Known follow-ups

- The concurrent session's 4 local-only commits (multitable/lobby) still
  need their own rebase onto origin (HomePage conflicts are theirs).
- Candidate next parity items: per-board RIT equity, SnapCam-style reaction
  clips, pot-splash celebration emote.
