/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY CHEST — click-to-open reveal, synced to the whole table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-20: "it needs to appear as like a suspense filled in screen with
 * a treasure chest that needs to be CLICKED TO OPEN, and then some animation
 * followed by an EXPLOSION with the amount of the mystery bounty revealed to
 * the winner. (ALL OTHER USERS AT THE TABLE SHOULD SEE THIS AS WELL IN REAL
 * TIME.)"
 *
 * There is an older MysteryBountyReveal (an envelope that opens ITSELF after
 * 1200ms) mounted on TournamentPage. It is not this: it cannot be clicked, it
 * is not a chest, and it never appears at the table where the knockout
 * actually happens. This component replaces it at the table.
 *
 * ─── The five beats ─────────────────────────────────────────────────────────
 *   landing    chest drops in and thumps                            (~700ms)
 *   locked     chest breathes, seams glow, dust rises — SUSPENSE    (until opened)
 *   opening    latch pops, lid swings, light floods the seam        (~900ms)
 *   explosion  white flash, shockwave, coin fountain                (~600ms)
 *   revealed   amount counts up, tier named, confetti on big ones   (~5s)
 *
 * ─── Who can open it ────────────────────────────────────────────────────────
 * Only the winner sees "TAP TO OPEN". Everyone else sees the same chest with
 * "<name> is opening the chest…" so the suspense is genuinely shared rather
 * than each client running its own private timeline.
 *
 * ─── How it stays in sync ───────────────────────────────────────────────────
 * The winner's tap broadcasts `mystery_chest_opened` on the table channel, and
 * every client transitions on receipt. The winner ALSO opens locally without
 * waiting for the round trip, so their own tap feels instant — the broadcast
 * is for everyone else.
 *
 * If the winner never taps (disconnected, AFK, looking away), the chest opens
 * itself after AUTO_OPEN_MS. That timer is owned by the WINNER'S client alone,
 * so nine spectators cannot fire nine broadcasts; every other client falls back
 * to its own longer failsafe only if no broadcast ever arrives.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { fireVibration } from '../../utils/vibrationGate';
import CoinShower from './CoinShower';
import { mediaUrl } from '../../utils/mediaBase';
import { formatPrizeAtUnit, moneySuffixAtUnit } from '../../utils/format';
import { CHIP_UNIT_CENTS, normalizeUnitCents } from '../../../server/src/tournament/tournamentUnit';
import './MysteryBountyChest.css';

export interface MysteryChestData {
  /**
   * The DESIGNATED REVEALER — the one player who may tap this chest open
   * (Dan sections 52/53). Everyone else at the table, and every spectator,
   * watches. On a split knockout the server picks exactly one of the
   * claimants; the money is still split between all of them.
   */
  knockerUserId: string;
  knockerName: string;
  eliminatedName: string;
  /**
   * The prize, in whole currency units.
   *
   * ZERO IS A LEGITIMATE VALUE HERE, and it means "not known yet". Under the
   * two-phase reveal (section 19) the chest appears BEFORE anyone has seen the
   * amount: the server's `mystery_bounty_pending` broadcast deliberately
   * carries no number, and the number only exists once the chest is opened.
   * `amountPending` says which of the two situations this is.
   */
  amount: number;
  /** The award this chest belongs to. Absent on the legacy one-shot path. */
  awardId?: string;
  /** True until the reveal lands. Gates the count-up, never the animation. */
  amountPending?: boolean;
  /**
   * SERVER-SUPPLIED TIER (section 50). `tier` is the inventory's own tier name
   * ('jackpot', 'mega', 'major', …) and drives the colour; `tierLabel` is what
   * the player reads. Both come from the chest that was actually drawn.
   */
  tier?: string;
  tierLabel?: string;
  isJackpot?: boolean;
  /**
   * Legacy fallback only. Before the server sent a tier the chest inferred one
   * from `amount / avgBounty` — see getTier(). Kept so an older engine build
   * still names its prizes.
   */
  avgBounty?: number;
  currency?: string;
  /** 1-based position in this table's reveal queue (sections 25/64). */
  queueIndex?: number;
  /** How many chests this burst holds in total. 1 or 0 hides the counter. */
  queueTotal?: number;
  /**
   * SECTION 28 — a shared knockout is ONE bounty, split. The chest shows the
   * full amount first (that is what the pot was worth), then who it divides
   * between. Absent or single-entry on an ordinary knockout.
   */
  recipients?: { userId: string; name: string; amount: number }[];
}

export interface MysteryBountyChestProps {
  data: MysteryChestData | null;
  /**
   * THE UNIT THE EVENT PAYS IN (2026-09-21), stated by the page that owns the
   * chest: TablePage passes `arenaAssetUnitCentsIfRead` off the table's own
   * arena, TournamentPage the selected row's `tournamentRowUnitCents`.
   *
   * A chip chest prints exactly what it always printed. A Diamond chest holds
   * whole Diamonds (`a_diamond_mystery_chest_holds_whole_diamonds`), so its
   * figure is whole Diamonds and says "Diamonds": this is the reveal of the
   * Diamond Arena's biggest moment, and a bare number there does not say what
   * was won. `null` means the table's arena has not been read yet, and the
   * figure is withheld until it has been, rather than printed in a currency
   * nobody looked up.
   */
  unitCents: number | null;
  /** The viewing player. Compared against knockerUserId to decide who may open. */
  viewerUserId: string | null;
  onDone: () => void;
  /**
   * Tell the rest of the table the chest was opened. Supplied by TablePage,
   * which owns the realtime channel. Absent -> local-only (still works).
   */
  onBroadcastOpen?: () => void;
  /**
   * The designated revealer is opening the chest — go and get the amount.
   *
   * TWO-PHASE REVEAL (section 19). The tap calls `fn_mystery_bounty_reveal`
   * FROM THE BROWSER and the amount comes straight back, which is the drama:
   * the player who made the knockout sees the number before the table does.
   * TablePage owns the RPC (this component owns no data access), feeds the
   * answer back in as `data.amount`, and the count-up — which does not start
   * until ~1.5s after the tap — reads whatever has arrived by then.
   *
   * Called at most ONCE per chest, from the tap and from the auto-open alike,
   * so section 54's failsafe cannot re-roll or double-pay.
   */
  onRequestReveal?: () => void;
  /** Set when another client's broadcast says the chest is open. */
  remoteOpened?: boolean;
  /** How many more chests are waiting behind this one. */
  queuedBehind?: number;
  /** False on a background table — visuals still run, audio does not. */
  playSounds?: boolean;
}

type Phase = 'idle' | 'landing' | 'locked' | 'opening' | 'explosion' | 'revealed';

/** Winner's grace period before the chest opens itself. */
/**
 * ART 2026-08-21 — Dan supplied rendered assets, so the chest is no longer
 * drawn in CSS:
 *
 *   mystery-chest.webp        the closed chest, alpha-keyed off its black
 *                             studio backdrop. This is the IDLE state: it
 *                             floats, its seam glows, and it is the tap target.
 *   mystery-chest-burst.mp4   the same chest bursting open into a gold geyser.
 *                             Plays at the moment of opening, composited with
 *                             `screen` blending so its pure-black background
 *                             drops out and only the light survives.
 *
 * Both are centered in their frames and their chests occupy nearly the same
 * fraction of frame width (0.79 still vs 0.765 video), so the video is drawn
 * ~3.7% wider than the still and the swap lands on the same silhouette.
 *
 * The CSS chest and the canvas CoinShower are both KEPT as the fallback path:
 * if the video cannot load or cannot autoplay, the sequence still runs. A
 * missing asset must never cost a player their bounty reveal.
 */
const CHEST_IMG = mediaUrl('images/mystery-chest.webp');
const CHEST_BURST_VIDEO = mediaUrl('videos/mystery-chest-burst.mp4');

const AUTO_OPEN_MS = 9000;
/** Spectator failsafe: only used if no broadcast ever lands. */
const SPECTATOR_FAILSAFE_MS = 14000;

/**
 * Keyed by BOTH vocabularies, because two exist and both are legitimate.
 *
 * The lower-case entries with no suffix are the server's inventory tier names
 * (`mysteryBountySpec.MysteryBountyTierName`) and are what a modern engine
 * sends as `tier`. The rest are the legacy label words that `getTier()` still
 * produces when no server tier is available. Looking up the raw tier first
 * (see the `tier` memo below) is what makes section 50 true: the colour and
 * the words come from the same chest.
 */
const TIER_COLORS: Record<string, string> = {
  // Server tier names.
  jackpot: '#6fdcff',
  mega: '#ef4444',
  major: '#a855f7',
  large: '#6fdcff',
  medium: '#6fdcff',
  small: '#60a5fa',
  base_plus: '#60a5fa',
  base: '#6b7280',
  // Legacy label words (getTier).
  min: '#6b7280',
  huge: '#1877f2',
  grand: '#a855f7',
};

/**
 * The words for a server tier name (Dan section 50).
 *
 * MIRRORS `server/src/config/mysteryBountySpec.ts:formatBountyTier`. The
 * engine sends the label on `mystery_bounty_revealed`, so this copy exists for
 * the one path that has no broadcast to read: the designated revealer's own
 * tap, which calls `fn_mystery_bounty_reveal` directly and gets back the raw
 * tier name and nothing else. If the tiers change, change both in the same
 * commit — a chest that is a Mega Prize on the tapper's screen and a Major
 * Prize on everyone else's is worse than no label at all.
 *
 * House rule (CLAUDE.md §5.7): First Letter Of Every Word Capitalized.
 */
const SERVER_TIER_LABELS: Record<string, string> = {
  jackpot: 'Jackpot',
  mega: 'Mega Prize',
  major: 'Major Prize',
  large: 'Large Prize',
  medium: 'Medium Prize',
  small: 'Small Prize',
  base_plus: 'Bonus Prize',
  base: 'Standard Prize',
};

export function formatBountyTierLabel(tier: string | null | undefined): string | undefined {
  const key = String(tier ?? '')
    .trim()
    .toLowerCase();
  return SERVER_TIER_LABELS[key];
}

/**
 * Tier from the amount relative to this event's average bounty. Kept identical
 * to the legacy MysteryBountyReveal so the same prize never gets two different
 * names depending on which surface showed it.
 */
export function getTier(amount: number, avgBounty: number): { label: string; color: string } {
  if (!avgBounty || avgBounty <= 0) return { label: 'Prize', color: '#60a5fa' };
  const ratio = amount / avgBounty;
  // Dan 2026-08-21: "capitalize the first letter of very word" — the house
  // rule already binding on popups now applies to every label the chest shows.
  if (ratio >= 50) return { label: 'Jackpot', color: TIER_COLORS.jackpot };
  if (ratio >= 20) return { label: 'Grand Prize', color: TIER_COLORS.grand };
  if (ratio >= 10) return { label: 'Mega Prize', color: TIER_COLORS.mega };
  if (ratio >= 5) return { label: 'Huge Prize', color: TIER_COLORS.huge };
  if (ratio >= 2.5) return { label: 'Large Prize', color: TIER_COLORS.large };
  if (ratio >= 1.5) return { label: 'Medium Prize', color: TIER_COLORS.medium };
  if (ratio >= 0.5) return { label: 'Small Prize', color: TIER_COLORS.small };
  return { label: 'Min Prize', color: TIER_COLORS.min };
}

/**
 * Timers this module armed, so an unmount can cancel them.
 *
 * canvas-confetti runs its own requestAnimationFrame loop against a canvas it
 * owns. When the chest unmounts mid-celebration the canvas goes away but the
 * queued frames do not, and the library calls clearRect on a null context:
 * "Cannot read properties of null (reading 'clearRect')". In the browser that
 * is a console error over a closed overlay; in CI it is an UNCAUGHT EXCEPTION
 * that fails the whole run — and the client suite now gates the bundle
 * publish, so a stray celebration could block a deploy.
 *
 * reset() tears the loop and the canvas down together.
 */
const confettiTimers = new Set<ReturnType<typeof setTimeout>>();
let confettiReset: (() => void) | null = null;

export function stopConfetti() {
  for (const t of confettiTimers) clearTimeout(t);
  confettiTimers.clear();
  try {
    confettiReset?.();
  } catch {
    /* the loop is already gone — nothing to tear down */
  }
  confettiReset = null;
}

function fireConfetti(isJackpot: boolean) {
  import('canvas-confetti')
    .then((mod) => {
      const confetti = mod.default;
      confettiReset = () => (confetti as unknown as { reset?: () => void }).reset?.();
      const gold = ['#6fdcff', '#00b4e6', '#0a5dc2', '#1877f2', '#e8eaf0'];
      confetti({
        particleCount: isJackpot ? 300 : 140,
        spread: isJackpot ? 180 : 110,
        origin: { y: 0.45 },
        colors: gold,
        scalar: isJackpot ? 1.3 : 1,
      });
      if (isJackpot) {
        confettiTimers.add(
          setTimeout(
            () =>
              confetti({
                particleCount: 150,
                spread: 120,
                origin: { y: 0.2, x: 0.2 },
                colors: gold,
              }),
            200
          )
        );
        confettiTimers.add(
          setTimeout(
            () =>
              confetti({
                particleCount: 150,
                spread: 120,
                origin: { y: 0.2, x: 0.8 },
                colors: gold,
              }),
            380
          )
        );
      }
    })
    .catch(() => {
      /* confetti is a bonus, never a requirement */
    });
}

export default function MysteryBountyChest({
  data,
  unitCents,
  viewerUserId,
  onDone,
  onBroadcastOpen,
  onRequestReveal,
  remoteOpened = false,
  queuedBehind = 0,
  playSounds = true,
}: MysteryBountyChestProps) {
  // The celebration must not outlive the overlay that fired it.
  useEffect(() => stopConfetti, []);
  const [phase, setPhase] = useState<Phase>('idle');
  const [displayAmount, setDisplayAmount] = useState(0);
  /**
   * How long the winner has been staring at a locked chest, in whole seconds.
   *
   * Suspense that stays at one intensity stops being suspense — it becomes a
   * paused screen. The chest rattles harder and the glow tightens the longer
   * it goes unopened, which also quietly communicates that something is going
   * to happen whether or not they tap.
   */
  const [tension, setTension] = useState(0);
  const [pressed, setPressed] = useState(false);
  /** False once the still or the video proves unusable — falls back to CSS art. */
  const [artOk, setArtOk] = useState(true);
  const [videoOk, setVideoOk] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafRef = useRef<number | null>(null);
  const openedRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const isWinner = !!data && !!viewerUserId && data.knockerUserId === viewerUserId;
  /**
   * SECTION 50 — the tier is the SERVER'S when it sends one.
   *
   * The colour keys off `data.tier`, the inventory's own tier name, and the
   * words come from `data.tierLabel`. Only when neither is present does the
   * legacy `amount / avgBounty` inference run, and that path exists solely for
   * an engine build older than 2026-08-25.
   */
  const tier = data?.tierLabel
    ? {
        label: data.tierLabel,
        color:
          TIER_COLORS[String(data.tier ?? '').toLowerCase()] ||
          TIER_COLORS[data.tierLabel.toLowerCase()] ||
          '#60a5fa',
      }
    : getTier(data?.amount ?? 0, data?.avgBounty ?? data?.amount ?? 0);
  const isJackpot = data?.isJackpot || tier.label.toLowerCase() === 'jackpot';

  /**
   * The latest amount, readable from inside a timer that was armed before it
   * arrived.
   *
   * `runOpen` schedules the count-up ~1.5s ahead and would otherwise capture
   * `data.amount` in its closure — which under the two-phase reveal is 0,
   * because the tap that fetches the real number happens on the same tick the
   * timer is armed. The ref is what lets the drama work: the chest starts
   * opening the instant it is tapped, and the number lands during the lid
   * swing.
   */
  const amountRef = useRef(data?.amount ?? 0);
  amountRef.current = data?.amount ?? 0;

  /**
   * THE CHEST'S IDENTITY, and why it is not the `data` object.
   *
   * Under the two-phase reveal the props CHANGE while the chest is on screen:
   * TablePage merges the amount, the tier and the recipient split in the
   * moment the reveal lands, which produces a new object on that render. Every
   * effect below keyed on `data` would tear the sequence down and restart it
   * from the landing thump — the chest would visibly re-drop the instant the
   * prize was known.
   *
   * The award id is what actually identifies a chest. 'legacy' covers the old
   * one-shot path, where the amount arrives with the chest and never changes,
   * and where the queue's null gap between items re-arms the effect anyway.
   */
  const chestKey = data ? (data.awardId ?? 'legacy') : null;

  /** One reveal request per chest — section 54: the tap and the failsafe are
   *  the same request, never two. */
  const revealRequestedRef = useRef<string | null>(null);
  const requestReveal = useCallback(() => {
    if (!chestKey) return;
    // SECTIONS 52/53: only the designated revealer opens the chest. Everyone
    // else — the rest of the table and every spectator — watches, and their
    // clients must not call the reveal RPC at all. `fn_mystery_bounty_reveal`
    // refuses them ('not_the_revealer'), so this is noise control rather than
    // security, but a table of ten firing a refused RPC each is nine refusals
    // per knockout.
    if (!isWinner) return;
    if (revealRequestedRef.current === chestKey) return;
    revealRequestedRef.current = chestKey;
    try {
      onRequestReveal?.();
    } catch {
      // The engine reveals this award authoritatively on its own deadline, so
      // a failed request costs the tapper their head start and nothing else.
    }
  }, [chestKey, isWinner, onRequestReveal]);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  // ANIMATION AUDIT 2026-08-27: `playSounds` (ambientSoundsAllowed) flips
  // whenever the player switches multi-table tab. It sat in the arrival
  // effect's and runOpen's dependency arrays, so a tab switch MID-CHEST tore
  // the sequence down, reset the opened latch, and re-dropped the chest from
  // the landing thump. It is a play-time gate, not sequence identity — read
  // it through a ref.
  const playSoundsRef = useRef(playSounds);
  playSoundsRef.current = playSounds;

  /** Run the open -> explosion -> reveal sequence. Idempotent. */
  const runOpen = useCallback(() => {
    if (openedRef.current || !chestKey) return;
    openedRef.current = true;
    // 2026-08-27: cancel the landing phase's pending `toLocked` — remote
    // opens / the spectator failsafe can fire inside the 700ms landing
    // window, and the stale timer then snapped the chest BACK to 'locked'
    // mid-open before it jumped to explosion.
    clearTimers();

    // Ask the server for the number, if it has not been asked already. This is
    // the TAP path and the AUTO-OPEN path in one line, which is what makes
    // "manual tap plus timeout cannot double-reveal" (section 80/31) true by
    // construction rather than by two guards that have to agree.
    requestReveal();

    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();
    setPhase('opening');

    // Roll the burst film on the same tick the lid starts moving. Autoplay is
    // permitted because the element is muted + playsInline, and this is inside
    // a user gesture on the winner's client; a rejected promise simply means
    // we keep the CSS/canvas path, which is why videoOk exists.
    if (!reduced) {
      const v = videoRef.current;
      if (v) {
        try {
          v.currentTime = 0;
          const pr = v.play();
          if (pr && typeof pr.catch === 'function') pr.catch(() => setVideoOk(false));
        } catch {
          setVideoOk(false);
        }
      }
    }

    if (playSoundsRef.current) {
      try {
        soundService.playMysteryChestOpen();
      } catch {
        /* best effort */
      }
    }
    fireVibration([20, 40, 30]);

    const openMs = (reduced ? 250 : 900) * speed;
    const boomMs = (reduced ? 150 : 600) * speed;

    const toExplosion = setTimeout(() => {
      setPhase('explosion');
      if (playSoundsRef.current) {
        try {
          soundService.playMysteryChestExplosion();
        } catch {
          /* best effort */
        }
      }
      fireVibration([50, 30, 80]);
    }, openMs);

    const toRevealed = setTimeout(() => {
      setPhase('revealed');
      if (playSoundsRef.current) {
        try {
          soundService.playMysteryBountyReveal();
        } catch {
          /* best effort */
        }
      }
      if (!reduced) fireConfetti(!!isJackpot);

      // Count the number UP rather than printing it. The climb is the reward;
      // a number that simply appears is a receipt.
      //
      // Read from the ref, not the closure: under the two-phase reveal the
      // amount arrives from `fn_mystery_bounty_reveal` DURING the lid swing,
      // after this timer was armed. The closure's copy would be the pre-reveal
      // zero, so the chest would explode into "0".
      if (reduced) {
        setDisplayAmount(amountRef.current);
      } else {
        const started = performance.now();
        const durationMs = 1100 * speed;
        const step = (now: number) => {
          // The reveal can also arrive DURING the climb. The amount effect
          // defers to this loop while it runs, so each frame must read the
          // latest prize rather than finish on the pre-reveal zero.
          const target = amountRef.current;
          const t = Math.min(1, (now - started) / durationMs);
          // Ease-out cubic: fast at first, settling onto the true figure.
          const eased = 1 - Math.pow(1 - t, 3);
          setDisplayAmount(Math.round(target * eased));
          if (t < 1) {
            rafRef.current = requestAnimationFrame(step);
          } else {
            rafRef.current = null;
            setDisplayAmount(target);
          }
        };
        rafRef.current = requestAnimationFrame(step);
      }
    }, openMs + boomMs);

    const toEnd = setTimeout(
      () => {
        setPhase('idle');
        onDoneRef.current();
      },
      openMs + boomMs + (reduced ? 2200 : 5200) * speed
    );

    timersRef.current.push(toExplosion, toRevealed, toEnd);
    // Keyed on the chest, not the data object: the props change mid-sequence
    // when the amount lands, and a new `runOpen` identity on that render would
    // re-arm the failsafe effects below against a chest that is already open.
  }, [chestKey, isJackpot, requestReveal]);

  /** The winner's tap. Opens locally at once, and tells everyone else. */
  const handleOpenClick = useCallback(() => {
    if (!isWinner || openedRef.current || phase !== 'locked') return;
    try {
      onBroadcastOpen?.();
    } catch {
      // A failed broadcast must not stop the winner seeing their own prize.
    }
    runOpen();
  }, [isWinner, phase, runOpen, onBroadcastOpen]);

  // ── Arrival ───────────────────────────────────────────────────────────────
  // KEYED ON chestKey, NOT `data`. See the chestKey comment: the props change
  // while the chest is on screen (the amount arrives), and depending on the
  // object identity here would re-drop the chest at the moment of the reveal.
  useEffect(() => {
    clearTimers();
    openedRef.current = false;
    revealRequestedRef.current = null;
    setDisplayAmount(0);

    if (!chestKey) {
      setPhase('idle');
      return;
    }

    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();

    setPhase('landing');
    if (playSoundsRef.current) {
      try {
        soundService.playMysteryChestLand();
      } catch {
        /* best effort */
      }
    }

    const toLocked = setTimeout(() => setPhase('locked'), (reduced ? 200 : 700) * speed);
    timersRef.current.push(toLocked);

    return clearTimers;
    // playSounds deliberately NOT a dep — see playSoundsRef above.
  }, [chestKey]);

  /**
   * The amount can land AFTER the count-up has already finished — a slow
   * reveal RPC, or a spectator whose `mystery_bounty_revealed` broadcast
   * arrived late. Snap to the true figure rather than leaving a chest that
   * exploded into nothing.
   */
  useEffect(() => {
    if (phase !== 'revealed') return;
    if (rafRef.current !== null) return; // the climb is still running
    const target = data?.amount ?? 0;
    if (target > 0) setDisplayAmount(target);
  }, [phase, data?.amount]);

  // ── Auto-open failsafes ───────────────────────────────────────────────────
  useEffect(() => {
    if (!chestKey || phase !== 'locked') return;

    // Only the WINNER'S client owns the real timer and the broadcast, so an
    // AFK winner cannot produce one broadcast per spectator.
    if (isWinner) {
      const t = setTimeout(() => {
        if (openedRef.current) return;
        try {
          onBroadcastOpen?.();
        } catch {
          /* ignore */
        }
        runOpen();
      }, AUTO_OPEN_MS * getAnimationSpeed());
      timersRef.current.push(t);
      return () => clearTimeout(t);
    }

    // Spectators: open anyway if no broadcast ever arrives, so a dropped
    // packet cannot leave the table staring at a chest forever.
    const t = setTimeout(() => {
      if (!openedRef.current) runOpen();
    }, SPECTATOR_FAILSAFE_MS * getAnimationSpeed());
    timersRef.current.push(t);
    return () => clearTimeout(t);
  }, [chestKey, phase, isWinner, runOpen, onBroadcastOpen]);

  // ── Someone else opened it ────────────────────────────────────────────────
  useEffect(() => {
    if (remoteOpened && chestKey && !openedRef.current && phase !== 'idle') {
      runOpen();
    }
  }, [remoteOpened, chestKey, phase, runOpen]);

  // ── Escalating tension while it sits locked ───────────────────────────────
  useEffect(() => {
    if (phase !== 'locked') {
      setTension(0);
      return;
    }
    const id = setInterval(() => setTension((t) => Math.min(t + 1, 6)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  if (!data || phase === 'idle') return null;

  const currency = data.currency ?? '';
  /**
   * One figure, at the event's unit. The chip branch is the chest's own
   * rendering, node for node; `currency` is a chip mark and never rides on a
   * Diamond. Unread (null) prints nothing at all.
   */
  const figure = (n: number): React.ReactNode =>
    unitCents == null ? null : normalizeUnitCents(unitCents) === CHIP_UNIT_CENTS ? (
      <>
        {currency}
        {n.toLocaleString()}
      </>
    ) : (
      `${formatPrizeAtUnit(n, unitCents)}${moneySuffixAtUnit(unitCents)}`
    );
  const canTap = isWinner && phase === 'locked';
  // Dan 2026-08-21: 'you should never have "50x the average bounty" — it's
  // just a random payout prize.' Mystery bounties are drawn from a prize
  // table; framing one as a multiple of the average implies the player earned
  // a ratio, which is not what happened. The figure stands on its own.

  return (
    <div
      className={`mbc mbc--${phase}${isJackpot ? ' mbc--jackpot' : ''}${
        pressed ? ' mbc--pressed' : ''
      }`}
      style={{ ['--mbc-tension' as string]: tension, ['--mbc-tier' as string]: tier.color }}
      role="dialog"
      aria-modal="true"
      aria-label="Mystery Bounty"
    >
      <div className="mbc__backdrop" />

      {/* Rising embers during the wait — the screen should feel alive while
          nothing is happening yet, or the suspense reads as a freeze. */}
      {(phase === 'landing' || phase === 'locked') && (
        <div className="mbc__embers" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className="mbc__ember" style={{ ['--mbc-e' as string]: i }} />
          ))}
        </div>
      )}

      <div className="mbc__stage">
        {/* Burst film. Mounted from the start (so it is buffered and ready to
            play on the tap with no stall) but invisible until the open beat.
            `screen` blending drops its pure-black backdrop, leaving only the
            chest, the light and the coins over the table. */}
        {videoOk && (
          <video
            ref={videoRef}
            className="mbc__burst-video"
            src={CHEST_BURST_VIDEO}
            muted
            playsInline
            preload="auto"
            aria-hidden="true"
            onError={() => setVideoOk(false)}
          />
        )}
        {/* SECTIONS 25 and 64 — three knockouts in one hand read
            "MYSTERY BOUNTY 1 OF 3", then 2 of 3, then 3 of 3, and the dealer
            button does not move until the last of them is done. The counter
            is the server's: it is computed once the whole burst is known, not
            per chest as it is reserved. */}
        <div className="mbc__eyebrow">
          {(data.queueTotal ?? 1) > 1
            ? `Mystery Bounty ${data.queueIndex ?? 1} Of ${data.queueTotal}`
            : 'Mystery Bounty'}
        </div>
        <div className="mbc__subject">
          <span className="mbc__winner-name">{data.knockerName}</span>
          <span className="mbc__subject-verb"> Eliminated </span>
          <span className="mbc__loser-name">{data.eliminatedName}</span>
        </div>

        {/* ── The chest ── */}
        <button
          type="button"
          className={`mbc__chest${canTap ? ' mbc__chest--tappable' : ''}`}
          onClick={handleOpenClick}
          /* Press physicality: the chest sinks under the finger and releases.
             A button that only reacts on click feels like a link; a lid you can
             feel yourself pushing on is what makes the tap satisfying. Pointer
             events rather than mouse/touch pairs so one path covers both. */
          onPointerDown={() => canTap && setPressed(true)}
          onPointerUp={() => setPressed(false)}
          onPointerLeave={() => setPressed(false)}
          onPointerCancel={() => setPressed(false)}
          disabled={!canTap}
          aria-label={canTap ? 'Tap To Open The Mystery Bounty Chest' : 'Mystery Bounty Chest'}
        >
          <span className="mbc__glow" aria-hidden="true" />

          {/* The rendered chest — the idle object the player actually taps.
              Hidden the moment the burst film takes over, so the still is
              never seen sitting behind an exploding copy of itself. */}
          {artOk && (
            <img
              className="mbc__chest-img"
              src={CHEST_IMG}
              alt=""
              draggable={false}
              onError={() => setArtOk(false)}
            />
          )}

          {/* Sparks escaping the seam while it is locked — the chest is
              straining to open, which is the whole feeling of the beat. */}
          {phase === 'locked' && (
            <span className="mbc__sparks" aria-hidden="true">
              {Array.from({ length: 7 }, (_, i) => (
                <span key={i} className="mbc__spark" style={{ ['--mbc-s' as string]: i }} />
              ))}
            </span>
          )}

          {/* ── The lid, as an actual box ──────────────────────────────
              Dan 2026-08-21: "it needs to feel premium and dynamic with depth
              and the 3D look and feel to it."

              A single rotating rectangle is a flap, not a lid — you see it is
              flat the moment it turns. This is a preserve-3d group with a top
              face, a front face and two end caps, hinged at its back edge, so
              as it swings the front face sweeps away and you look INTO the
              box. The wood grain and the brass bands are painted on the faces
              that carry them, which is what sells the thickness. */}
          <span className="mbc__lid" data-css-art={!artOk || undefined} aria-hidden="true">
            <span className="mbc__lid-top">
              <span className="mbc__lid-band" />
              <span className="mbc__lid-stud mbc__lid-stud--l" />
              <span className="mbc__lid-stud mbc__lid-stud--r" />
            </span>
            <span className="mbc__lid-front">
              <span className="mbc__lid-front-band" />
            </span>
            <span className="mbc__lid-end mbc__lid-end--l" />
            <span className="mbc__lid-end mbc__lid-end--r" />
          </span>

          {/* The light escaping from inside, revealed as the lid lifts. */}
          <span className="mbc__inner-light" aria-hidden="true" />

          {/* God-rays fanning out of the open chest. These are what sell the
              idea that something enormous is inside, rather than that a box
              opened. Only rendered once the lid is actually moving. */}
          {(phase === 'opening' || phase === 'explosion' || phase === 'revealed') && (
            <span className="mbc__rays" aria-hidden="true">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className="mbc__ray" style={{ ['--mbc-r' as string]: i }} />
              ))}
            </span>
          )}

          <span className="mbc__base" data-css-art={!artOk || undefined} aria-hidden="true">
            {/* The cavity is drawn BEHIND the front wall, so when the lid
                lifts there is a dark interior with gold light in it rather
                than a flat panel that changed colour. */}
            <span className="mbc__cavity">
              <span className="mbc__cavity-gold" />
            </span>
            <span className="mbc__base-front">
              <span className="mbc__base-band" />
              <span className="mbc__lock">
                <span className="mbc__lock-hole" />
              </span>
              <span className="mbc__base-stud mbc__base-stud--l" />
              <span className="mbc__base-stud mbc__base-stud--r" />
            </span>
            <span className="mbc__base-rim" />
          </span>
          <span className="mbc__shadow" aria-hidden="true" />

          <span className="mbc__seam" aria-hidden="true" />
        </button>

        {/* ── Explosion layer ── */}
        {(phase === 'explosion' || phase === 'revealed') && (
          <>
            <div className="mbc__flash" aria-hidden="true" />
            <div className="mbc__shock" aria-hidden="true" />
            <div className="mbc__shock mbc__shock--2" aria-hidden="true" />
            {/* Dan 2026-08-21: "the chest should explode with coins like a
                coin shower when you hit a jackpot on a slot machine." Eighteen
                DOM spans on CSS transitions could be counted; this is a real
                particle system — hundreds of coins on ballistic arcs that
                spin, foreshorten, land and bounce. See CoinShower.tsx. */}
            <CoinShower
              active={!videoOk}
              isJackpot={!!isJackpot}
              originX={0.5}
              originY={0.46}
              speed={getAnimationSpeed()}
              reduced={prefersReducedMotion()}
            />
          </>
        )}

        {/* ── Prompt / status ── */}
        {phase === 'locked' && (
          <div className="mbc__prompt">
            {isWinner ? (
              <>
                <span className="mbc__prompt-main">Tap The Chest To Open</span>
                <span className="mbc__prompt-sub">Your Bounty Is Inside</span>
              </>
            ) : (
              <>
                <span className="mbc__prompt-main mbc__prompt-main--waiting">
                  {data.knockerName} Is Opening The Chest
                  <span className="mbc__dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
                <span className="mbc__prompt-sub">Watch The Reveal</span>
              </>
            )}
          </div>
        )}

        {/* ── Reveal ── */}
        {phase === 'revealed' && (
          <div className="mbc__reveal">
            <div className="mbc__tier" style={{ color: tier.color }}>
              {tier.label}
            </div>
            <div className="mbc__amount" style={{ ['--mbc-tier' as string]: tier.color }}>
              {figure(displayAmount)}
            </div>
            {/* SECTION 28 — a shared knockout is ONE bounty, split. The full
                amount above is what the chest held; this is who it divides
                between. Shown only when there is more than one claimant, so
                the ordinary knockout is untouched. */}
            {data.recipients && data.recipients.length > 1 ? (
              <div className="mbc__split">
                <div className="mbc__split-head">
                  Split {data.recipients.length} Ways - Shared Knockout
                </div>
                {data.recipients.map((r) => (
                  <div className="mbc__split-row" key={r.userId}>
                    <span className="mbc__split-name">{r.name}</span>
                    <span className="mbc__split-amount">{figure(r.amount)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mbc__won-by">
                Won By <strong>{data.knockerName}</strong>
              </div>
            )}
          </div>
        )}

        {/* The legacy "+2 more" hint. Suppressed when the server sent a real
            queue counter, which says the same thing in the eyebrow and says it
            more precisely. */}
        {queuedBehind > 0 && (data.queueTotal ?? 1) <= 1 && (
          <div className="mbc__queued">
            +{queuedBehind} More Bount{queuedBehind > 1 ? 'ies' : 'y'} To Reveal
          </div>
        )}
      </div>
    </div>
  );
}
