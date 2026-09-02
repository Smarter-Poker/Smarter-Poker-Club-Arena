# Live-Play Animation + Sound Audit — every animation, every time (2026-08-28)

Dan: animations and sounds were firing inconsistently at the live tables —
"some play, some don't, some play sometimes, some not at all." A full audit of
every live-play animation traced each one from trigger to cleanup. Nineteen
distinct defects were found and fixed. No behavior was removed; every fix makes
an existing beat fire reliably, for its full duration, with its sound.

## Sound engine (SoundService.ts and friends)

- **Thirteen `playTone` calls had volume and delay SWAPPED** (the 2026-08-20
  Spin/Mystery/Bounty pass was written in ThrowableSoundService's argument
  order). Six cues were fully silent — the NASCAR countdown lights, the spin
  lever thunk, the wheel-seating thump, the chest's landing thud, the latch
  pop — and three (chest shimmer, coin shower) played at 3-7x the intended
  volume. All restored to (freq, duration, volume, type, delay).
- **`playPotCollect` was still suppressed 100% of the time on hero wins.** The
  2026-08-20 fix gave it rank 88, but the gate rejects `rank <=` the frame's
  winner fanfare (90/95). It now bypasses the rank window (it accompanies the
  fanfare, it does not compete) with its own 250ms dedupe.
- **The deal's card-slide sounds are scheduled once on the AudioContext clock**
  (`playDealSequence`) instead of one setTimeout per card — main-thread bunching
  inside the 50ms priority window silently dropped slides on busy frames.
- **Quads-or-better double fanfare removed**: the reveal-time `playBigWin`
  (spec 43) now stamps itself and the pot-time escalation downgrades to the
  normal win cue within 8s.
- **Category sub-toggles and volumes now survive a reload** — restored from
  `sp_sound_settings` at boot. Previously in-memory only, so the panel's
  checkboxes and the running engine disagreed all session.
- `playButtonClick` / `playSeatTaken` / `playDisconnect` / `playReconnect` now
  carry the 'event' category instead of bypassing every sub-toggle.
- **Effects volume default raised 0.5 → 1.0** to match the Settings panel's own
  default; players who never opened Settings ran at half gain forever, and the
  in-table master slider topped out at an effective 0.5.
- **The mute can no longer be silently destroyed**: the hamburger sound toggle
  now writes BOTH soundGate keys via `setEnabled` (before: switch read ON,
  app stayed silent), and `useTableSound`'s mount sync moved out of the render
  body and seeds from the shared gate instead of one key (before: opening a
  table un-muted a Settings mute).
- **ThrowableSoundService installs autoplay-unlock listeners** — its lazy
  context was born suspended on mobile when the first throw was an incoming
  broadcast, and nothing ever retried: all throw audio stayed dead.

## Wiring (TablePage.tsx)

- **Incoming throws launched from off-screen instead of the thrower's seat**:
  the room-message handler pinned the first-commit `parseIncomingMessage`,
  whose roster was empty, so the sender never resolved. Handler now reads
  render-synced refs (same fix for the stale `ambientSoundsAllowed`).
- **Back-to-back big wins produced one confetti burst / one particle burst**
  (edge-gated state was already true). Clear-then-set on the next macrotask —
  every qualifying win gets its own burst.
- **The 50BB+ screen shake hit the wrong table in multi-table mode**
  (`document.querySelector` finds the first `.table-page` in DOM order), was
  stripped mid-keyframe at slow animation speeds (hardcoded 600ms vs
  `calc(0.4s * --animation-speed)`), and re-anchored the fixed-position chip
  layer (transform on an ancestor) — displacing every chip in flight at the
  exact moment the pot ships. It now targets this table's scaler, scales its
  removal window, and the chip layer mounts OUTSIDE the scaler.

## Components

- **Showdown flips could cancel and never reschedule** (SeatSlot): the reveal
  order reconciliation re-ran the effect mid-hold, cleanup killed the timer,
  and the rising-edge guard refused a retry — cards snapped face-up with no
  flip. Timers moved to component-scope refs; a pending hold is never
  cancelled by a reorder.
- **Mystery chest re-dropped and knockout restarted on multi-table tab
  switches** — `playSounds` sat in their sequence effects' deps. Now read via
  ref. The chest also no longer snaps back to 'locked' when a remote open
  lands inside the landing window (stale timer cleared).
- **The deal-animation give-up window (800ms) was shorter than the roster race
  it exists for** — a slow snapshot meant that hand silently got no deal
  animation. Raised to 1600ms (the action-panel hold's own 2600ms ceiling
  still protects the player).
- **Board cards could keep their deal-in class until the next street**
  (CommunityCards): the first all-in equity broadcast flipping `slowReveal`
  mid-window cancelled the clear without rescheduling it. Re-armed for the
  window's remainder.
- **Confetti/particle canvases never completed in hidden tabs** (no rAF), so
  the latched parent state swallowed the next win's burst on return. Wall-clock
  backstop completes them on schedule.
- **Bomb pot screen shake no longer lives inside the sound gate** — muted
  players get the explosion shake.
- **Laugh/Shock/Dead reactions were indistinguishable** — all three shared the
  glyph '◆' (duplicate React keys, ambiguous wire format). Unique symbols now.
- Throw flinch/shake selectors scoped to their own table (multi-table), with a
  cushion over the 450ms keyframe.

## CSS / reduced motion

- `.seat--allin-shake` now scales with `--animation-speed` (was cut at 50% on
  Fast); the folding/showdown second-card delays scale too (margin was 5ms at
  Fast).
- **The turn-clock ring survives Reduce Motion** via `data-motion="keep"` — the
  global 1ms collapse was finishing every countdown instantly, for every seat.
- The BBJ credit pill no longer stays welded to the seat forever under Reduce
  Motion; the stale duplicate reduced-motion block in animations.css is gone.

## MasterBus

- Gameplay-animation events (BOMB*POT*\*, SHOWDOWN_CARDS_REVEALED, RIT_OFFERED,
  BBJ_HIT, POT_DISTRIBUTED) added to the dedup bypass — two structurally
  identical payloads inside 500ms lost the second animation with only a
  console.debug.

## Tests

- The three pins on replaced behavior updated in this same commit: deal-sound
  assertions now count slides scheduled through `playDealSequence`, and the
  effects-volume default test pins 1.0.
- Full suite: 502 files / 7892 tests green. `npx tsc --noEmit` clean.
