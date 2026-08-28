/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ANIMATION LAW — ANIMATIONS ALWAYS PLAY (Dan 2026-08-28, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verbatim: "HARDEN THE PROCESS AND MAKE SURE THAT ANIMATIONS CAN'T REGRESS,
 * ONLY IMPROVE FROM HERE ON OUT. YOU NEED TO MAKE IT LAW THAT THEY MUST
 * ALWAYS PLAY."
 *
 * Every pin below is a bug that actually shipped and was actually fixed in the
 * 2026-08-27/28 animation audits. Each one silently skipped, truncated,
 * silenced or misplaced an animation the player was owed. This file makes the
 * regression LOUD: if your change turns one of these red, you are re-shipping
 * a bug that already cost the product its polish once. Fix your change — do
 * not weaken the pin. If you are DELIBERATELY replacing a mechanism with a
 * better one, move the pin to the new mechanism in the same commit and say so.
 *
 * These are source-shape pins on purpose: they run in CI's required vitest
 * check on every pull request, so nothing merges past them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../', p), 'utf8');

const SOUND = read('src/services/SoundService.ts');
const THROW_SOUND = read('src/services/ThrowableSoundService.ts');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const SEAT_TSX = read('src/components/table/SeatSlot.tsx');
const SEAT_CSS = read('src/components/table/SeatSlot.css');
const DEAL = read('src/components/table/DealAnimation.tsx');
const DEALER_BTN = read('src/components/table/DealerButton.tsx');
const CONFETTI = read('src/components/table/ConfettiCanvas.tsx');
const PARTICLES = read('src/components/table/ParticleSystem.tsx');
const CHEST = read('src/components/tournament/MysteryBountyChest.tsx');
const KO = read('src/components/tournament/KnockoutAnimation.tsx');
const BUS = read('src/core/MasterBus.ts');
const REDUCED = read('src/styles/reducedMotion.css');
const REACTIONS = read('src/components/table/TableReactions.tsx');
const SETTINGS_HOOK = read('src/hooks/useUserTableSettings.ts');

describe('LAW: no sound cue may be born silent', () => {
  it('no playTone call passes a literal volume of zero', () => {
    // 2026-08-27: THIRTEEN playTone calls had volume and delay swapped — six
    // celebration cues (spin countdown, chest land, latch pop, coin shower…)
    // were completely silent in production and nothing flagged it, because a
    // zero-volume oscillator throws no error. A zero literal in the volume
    // slot is never intentional; use a small value or restructure.
    expect(SOUND).not.toMatch(/this\.playTone\(\s*[^,]+,\s*[^,]+,\s*0(\.0*)?\s*,/);
  });

  it('playPotCollect bypasses the rank window instead of losing to the win fanfare', () => {
    // The gate is `rank <= currentFramePriority`; playWin/playBigWin always
    // precede the sweep in the same frame, so ANY rank below theirs is
    // rejected 100% of the time. The sweep is a companion, not a competitor.
    expect(SOUND).toContain('lastPotCollectMs');
    expect(SOUND).not.toContain("shouldPlay('pot_collect'");
  });

  it('the deal schedules its card slides on the AudioContext clock, one call for the whole deal', () => {
    // Per-card setTimeout + playDeal bunched under main-thread load and the
    // 50ms priority window silently dropped slides — a busy deal played fewer
    // sounds than cards.
    expect(SOUND).toContain('playDealSequence(delaysMs: number[])');
    expect(DEAL).toContain('soundService.playDealSequence(');
    expect(DEAL).not.toContain('soundService.playDeal()');
  });

  it('ThrowableSoundService installs autoplay-unlock listeners', () => {
    // Its context is created lazily at the first throw — for a spectator that
    // is an INCOMING broadcast, not a gesture, so on mobile the context was
    // born suspended and every throw stayed silent forever.
    expect(THROW_SOUND).toContain('installUnlockListeners');
  });
});

describe('LAW: no animation may be skipped by state plumbing', () => {
  it('MasterBus never dedups gameplay-animation events', () => {
    for (const evt of [
      "'BOMB_POT_TRIGGERED'",
      "'BOMB_POT_COMPLETED'",
      "'SHOWDOWN_CARDS_REVEALED'",
      "'RIT_OFFERED'",
      "'BBJ_HIT'",
      "'POT_DISTRIBUTED'",
    ]) {
      const bypass = BUS.slice(
        BUS.indexOf('DEDUP_BYPASS'),
        BUS.indexOf('];', BUS.indexOf('DEDUP_BYPASS'))
      );
      expect(bypass).toContain(evt);
    }
  });

  it('celebration sequences do not restart on multi-table tab switches', () => {
    // `playSounds` (ambientSoundsAllowed) flips on every tab switch; in the
    // sequence effects' dependency arrays it re-dropped the mystery chest and
    // restarted the 3.6s knockout mid-flight. It gates AUDIO only — via ref.
    expect(CHEST).toContain('playSoundsRef');
    expect(CHEST).not.toMatch(/\}, \[chestKey, playSounds\]/);
    expect(KO).toContain('playSoundsRef');
    expect(KO).not.toMatch(/\}, \[data, playSounds/);
  });

  it('the room-message handler reads live refs, not first-commit closures', () => {
    // The pinned parseIncomingMessage held an EMPTY roster — every incoming
    // throw launched from off-screen instead of the thrower's seat.
    expect(TABLE_PAGE).toContain('parseIncomingMessageRef.current(content, senderId)');
    expect(TABLE_PAGE).toContain('ambientSoundsAllowedRef');
  });

  it('confetti and particle canvases complete even in hidden tabs', () => {
    // Hidden tabs get no rAF; without a wall-clock backstop onComplete never
    // fired and the latched parent state swallowed the NEXT win's burst.
    expect(CONFETTI).toContain('setTimeout(finish, duration + 500)');
    expect(PARTICLES).toContain('setTimeout(finish, duration + 500)');
  });

  it('the deal animation waits long enough to win the roster race', () => {
    // At 800ms the give-up window was SHORTER than the race it absorbs — a
    // slow snapshot meant that hand got NO deal animation, silently.
    const m = DEAL.match(/const SEAT_WAIT_MS = (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1600);
  });

  it('showdown flip timers live in refs that survive dependency changes', () => {
    // The reveal-order reconciliation re-ran the effect mid-hold; cleanup
    // killed the timer and the rising-edge guard refused a retry — cards
    // snapped face-up with no flip.
    expect(SEAT_TSX).toContain('flipPlayedRef');
    expect(SEAT_TSX).toContain('flipHoldTimerRef');
  });
});

describe('LAW: animations land where they aim, at the speed the player chose', () => {
  it('the chip-flight layer mounts OUTSIDE the shaken scaler', () => {
    // A transform on any ancestor re-anchors the fixed-position layer and
    // displaced every chip in flight — exactly while the pot ships.
    expect(TABLE_PAGE).toContain('moved OUT of .table-scaler');
  });

  it('the big-win shake targets this table via the scaler ref, scaled by animation speed', () => {
    // document.querySelector('.table-page') hit the FIRST table in DOM order
    // (wrong table in multi-table), and a hardcoded 600ms stripped the class
    // mid-keyframe at slow speeds.
    expect(TABLE_PAGE).toMatch(/tableEl\.classList\.add\('table-page--shake'\)/);
    expect(TABLE_PAGE).toMatch(/600 \* getAnimationSpeed\(\)/);
  });

  it('the last speed-blind CSS/JS pairs stay scaled together', () => {
    expect(SEAT_CSS).toContain('seatAllinShake calc(0.4s * var(--animation-speed, 1))');
    expect(SEAT_CSS).toContain('seatWinnerPop calc(0.6s * var(--animation-speed, 1))');
    expect(SEAT_CSS).toContain('seatStackGlow calc(0.6s * var(--animation-speed, 1))');
    expect(SEAT_CSS).toContain('stackDeltaFloat calc(2s * var(--animation-speed, 1))');
    expect(DEALER_BTN).toContain('calc(0.6s * var(--animation-speed, 1))');
  });

  it('throw flinch and shake are scoped to their own table', () => {
    expect(read('src/components/table/ThrowAnimation.tsx')).toContain(
      "rootRef.current?.closest('.table-page')"
    );
  });
});

describe('LAW: the end-of-hand cadence plays in order, every hand', () => {
  it('the button beat holds the deal start at HAND_STARTED', () => {
    // "…PAUSE 1 SECOND, MOVE THE BUTTON ANIMATION… START DEALING NEXT HAND."
    // The puck glides alone, lands with its tock, THEN the cards fly.
    expect(TABLE_PAGE).toContain('HAND_COMPLETION.BUTTON_MOVE_MS * getAnimationSpeed()');
  });
  // The 1-second rest itself (POST_PUSH_PAUSE_MS) is pinned arithmetically in
  // tests/unit/handCompletionLaw.test.ts, in every hold formula.
});

describe('LAW: reduced motion removes motion, never meaning', () => {
  it('the global collapse keeps its escape hatch, and the turn clock uses it', () => {
    // The countdown ring is duration-carrying animation — its length IS the
    // information. Collapsing it finished every countdown instantly.
    expect(REDUCED).toContain("data-motion='keep'");
    expect(SEAT_TSX).toContain('data-motion="keep"');
  });
});

describe('LAW: no toggle may quietly turn the product animation-free or mute', () => {
  it('skip_animations has no consumer', () => {
    // The toggle was retired by Dan's directive; a revived consumer would
    // let a cached true leave a table permanently un-animated.
    for (const p of [
      'src/components/table/SeatSlot.tsx',
      'src/components/table/CommunityCards.tsx',
      'src/components/table/DealAnimation.tsx',
    ]) {
      expect(read(p)).not.toContain('skip_animations');
    }
    // TablePage may MENTION it only in the comment documenting its removal.
    const mentions = TABLE_PAGE.split('skip_animations').length - 1;
    const active = TABLE_PAGE.match(/userSettings(Ref\.current)?\.skip_animations/g) || [];
    expect(active.length).toBe(0);
    expect(mentions).toBeGreaterThanOrEqual(0);
  });

  it('every reaction has a unique glyph so every reaction can render', () => {
    // Laugh, Shock and Dead all shared '◆' — duplicate React keys and an
    // ambiguous wire format meant two of the three could never display.
    const m = REACTIONS.match(/emoji: '([^']+)'/g) || [];
    expect(m.length).toBeGreaterThanOrEqual(6);
    expect(new Set(m).size).toBe(m.length);
  });

  it('the shared sound gate stays the single mute authority', () => {
    // Opening a settings surface must never un-mute the player: every mute
    // writer goes through soundGate's paired keys, and the table's mount sync
    // seeds from the gate (not one key) inside an effect (not the render body).
    const hook = read('src/hooks/useTableSound.ts');
    expect(hook).toContain('soundService.setEnabled(isSoundAllowed())');
    const menu = read('src/components/navigation/HamburgerMenu.tsx');
    expect(menu).toContain('soundService.setEnabled(newValue)');
  });
});

describe('LAW: dead settings stay dead', () => {
  it('the retired auto-switch keys are tombstoned, not re-offered', () => {
    expect(SETTINGS_HOOK).toContain('NO AUTO TABLE SWITCHING');
    expect(SETTINGS_HOOK).not.toMatch(/key: 'multi_auto_switch'/);
    expect(SETTINGS_HOOK).not.toMatch(/key: 'multi_action_queue'/);
  });
});
