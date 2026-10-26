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
  /**
   * PICK 1 OF 3 (Dan 2026-10-22). How many sealed chests the knockout picks
   * from. Absent or 1 is the single chest it always was.
   */
  offerSlots?: number;
  /** The slot the revealer picked (1-based), once the server has it. */
  pickedSlot?: number | null;
  /**
   * True when the 5-second pick window ran out and the slot was drawn at
   * random for the revealer (Dan 2026-10-25). Carried on the revealer's open
   * broadcast so every seat says the same thing.
   */
  autoPicked?: boolean;
  /**
   * False when nobody picked and the chest opened by itself: the slot is then
   * the server's, not a choice. Absent on an older server answer.
   */
  chosen?: boolean;
  /**
   * Every chest that was on offer, with what it held. Only present once the
   * award is revealed: the picked one is the prize, the others are real chests
   * of this event that stay in the pool.
   */
  choices?: MysteryChestChoice[];
}

/** One chest of a pick-1-of-3 offer, after the reveal. */
export interface MysteryChestChoice {
  slot: number;
  /** Whole currency units, like `MysteryChestData.amount`. */
  amount: number;
  tier?: string;
  tierLabel?: string;
  picked: boolean;
}

/**
 * Read `fn_mystery_bounty_offer`. Null for anything that is not a well-formed
 * answer, so a caller never shows chests the server did not describe.
 */
export function parseMysteryChestOffer(raw: unknown): {
  slots: number;
  pickedSlot: number | null;
  chosen?: boolean;
  revealed?: boolean;
  choices?: MysteryChestChoice[];
} | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.ok !== true) return null;
  const slots = Math.floor(Number(o.slots));
  if (!Number.isFinite(slots) || slots < 1 || slots > 3) return null;
  const pick = o.picked_slot == null ? null : Math.floor(Number(o.picked_slot));
  const pickedSlot = pick != null && pick >= 1 && pick <= slots ? pick : null;
  const raws = Array.isArray(o.choices) ? (o.choices as Array<Record<string, unknown>>) : [];
  const choices: MysteryChestChoice[] = raws
    .map((c) => ({
      slot: Math.floor(Number(c?.slot)),
      amount: Math.round(Number(c?.amount_cents)) / 100,
      tier: typeof c?.tier === 'string' ? c.tier : undefined,
      tierLabel: formatBountyTierLabel(typeof c?.tier === 'string' ? c.tier : null),
      picked: c?.picked === true,
    }))
    .filter((c) => c.slot >= 1 && c.slot <= slots && Number.isFinite(c.amount) && c.amount > 0)
    .sort((a, b) => a.slot - b.slot);
  return {
    slots,
    pickedSlot,
    ...(typeof o.chosen === 'boolean' ? { chosen: o.chosen } : {}),
    ...(typeof o.revealed === 'boolean' ? { revealed: o.revealed } : {}),
    choices: choices.length === slots ? choices : undefined,
  };
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
   * Carries the slot the revealer picked when the knockout chose from three.
   */
  onBroadcastOpen?: (slot?: number, autoPicked?: boolean) => void;
  /** The chest started opening on this client (tap, timeout or remote). */
  onOpened?: () => void;
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
  onRequestReveal?: (slot?: number) => void;
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

/**
 * THE PICK WINDOW IS FIVE SECONDS (Dan 2026-10-25, verbatim): "THEY HAVE 5
 * SECONDS TO PICK THERE BOX, AND IF THEY DON'T RANDOMLY CHOOSE IT. AND YOU
 * MUST ALWAYS SHOW THE OTHER 2 PRIZES THAT 'COULD OF BEEN CHOOSEN'."
 *
 * Five real seconds from the moment the chests can be tapped. It is NOT
 * stretched by Animation Speed: it is a decision clock, not an animation.
 */
export const PICK_WINDOW_MS = 5000;
/**
 * The engine's own reveal deadline after the chests become tappable
 * (mysteryBountySpec: landing + CHEST_AUTO_OPEN_MS from the reserve). The
 * revealer's window always closes this far inside it, so a pick made on the
 * last second is recorded before the server opens the chest itself.
 */
const ENGINE_PICK_DEADLINE_MS = 9000;
const SERVER_DEADLINE_MARGIN_MS = 800;
export function winnerAutoOpenMs(_speed?: number): number {
  return Math.min(PICK_WINDOW_MS, ENGINE_PICK_DEADLINE_MS - SERVER_DEADLINE_MARGIN_MS);
}

/**
 * A uniformly random slot in 1..slots, from the browser's CSPRNG. Used when
 * the pick window runs out: the chest is chosen FOR the player, at random,
 * never "the first one".
 */
export function randomPickSlot(slots: number): number {
  const n = Math.max(1, Math.floor(slots));
  try {
    const buf = new Uint32Array(1);
    // Rejection sampling keeps the three slots exactly equally likely.
    const limit = Math.floor(0x100000000 / n) * n;
    do {
      globalThis.crypto.getRandomValues(buf);
    } while (buf[0] >= limit);
    return 1 + (buf[0] % n);
  } catch {
    return 1 + Math.floor(Math.random() * n);
  }
}
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
  onOpened,
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
  /** PICK 1 OF 3: how many chests are on offer, and whether to show the choice. */
  const offerSlots = Math.max(1, Math.min(3, Math.floor(Number(data?.offerSlots) || 1)));
  const choosing = offerSlots > 1;
  /** The slot this client picked, so the chest it tapped is the one marked. */
  const [localPick, setLocalPick] = useState<number | null>(null);
  /** True when this client's 5-second window ran out and drew the slot. */
  const [localAutoPicked, setLocalAutoPicked] = useState(false);
  /** Whole seconds left on the pick window, for the countdown. */
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(PICK_WINDOW_MS / 1000));
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
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
  /* Read through a ref: TablePage passes an inline arrow, so depending on it
     gave requestReveal, runOpen and the auto-open effect a new identity on
     every table render, and the winner's auto-open timer restarted each time
     (2026-10-22). The latest callback is still the one called. */
  const onRequestRevealRef = useRef(onRequestReveal);
  onRequestRevealRef.current = onRequestReveal;
  const requestReveal = useCallback(
    (slot?: number) => {
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
        onRequestRevealRef.current?.(slot);
      } catch {
        // The engine reveals this award authoritatively on its own deadline, so
        // a failed request costs the tapper their head start and nothing else.
      }
    },
    [chestKey, isWinner]
  );

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
  const runOpen = useCallback(
    (slot?: number) => {
      if (openedRef.current || !chestKey) return;
      openedRef.current = true;
      try {
        onOpenedRef.current?.();
      } catch {
        /* presentation hook only */
      }
      // 2026-08-27: cancel the landing phase's pending `toLocked` — remote
      // opens / the spectator failsafe can fire inside the 700ms landing
      // window, and the stale timer then snapped the chest BACK to 'locked'
      // mid-open before it jumped to explosion.
      clearTimers();

      // Ask the server for the number, if it has not been asked already. This is
      // the TAP path and the AUTO-OPEN path in one line, which is what makes
      // "manual tap plus timeout cannot double-reveal" (section 80/31) true by
      // construction rather than by two guards that have to agree.
      requestReveal(slot);

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

      /* NEVER COUNT UP TO ZERO (Dan 2026-10-25: "THE LAST TWO PLAYERS GET
       ZERO APPEAR ON THE SCREEN INSTEAD OF THE PRIZE THEY GOT"). A seat that
       opened on the revealer's tap can reach this beat before the amount has
       reached it, and it used to climb to 0 and close before the real figure
       arrived. The reveal now waits, glowing, for the amount; the full reveal
       beat then runs from the moment the figure is known. Bounded, so a chest
       whose amount never reaches this seat still finishes. */
      const AMOUNT_POLL_MS = 150;
      const AMOUNT_WAIT_MAX_MS = 15000;
      let waitedMs = 0;
      const awaitAmount = () => {
        if (amountRef.current > 0 || waitedMs >= AMOUNT_WAIT_MAX_MS) {
          revealNow();
          return;
        }
        waitedMs += AMOUNT_POLL_MS;
        timersRef.current.push(setTimeout(awaitAmount, AMOUNT_POLL_MS));
      };

      const revealNow = () => {
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

        // The full reveal beat runs from the moment the figure is on screen.
        timersRef.current.push(
          setTimeout(
            () => {
              setPhase('idle');
              onDoneRef.current();
            },
            (reduced ? 2200 : 5200) * speed
          )
        );
      };

      const toRevealed = setTimeout(awaitAmount, openMs + boomMs);

      timersRef.current.push(toExplosion, toRevealed);
      // Keyed on the chest, not the data object: the props change mid-sequence
      // when the amount lands, and a new `runOpen` identity on that render would
      // re-arm the failsafe effects below against a chest that is already open.
    },
    [chestKey, isJackpot, requestReveal]
  );

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

  /**
   * PICK 1 OF 3 (Dan 2026-10-22). The revealer taps one of the sealed chests.
   * That chest is the one that opens, its slot is recorded before the reveal,
   * and the table is told which one was chosen.
   */
  const handlePick = useCallback(
    (slot: number) => {
      if (!isWinner || openedRef.current || phase !== 'locked') return;
      setLocalPick(slot);
      try {
        onBroadcastOpen?.(slot);
      } catch {
        // A failed broadcast must not stop the winner seeing their own prize.
      }
      runOpen(slot);
    },
    [isWinner, phase, runOpen, onBroadcastOpen]
  );

  // ── Arrival ───────────────────────────────────────────────────────────────
  // KEYED ON chestKey, NOT `data`. See the chestKey comment: the props change
  // while the chest is on screen (the amount arrives), and depending on the
  // object identity here would re-drop the chest at the moment of the reveal.
  useEffect(() => {
    clearTimers();
    openedRef.current = false;
    revealRequestedRef.current = null;
    setDisplayAmount(0);
    setLocalPick(null);
    setLocalAutoPicked(false);
    setSecondsLeft(Math.ceil(PICK_WINDOW_MS / 1000));

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
        /* TIME RAN OUT (Dan 2026-10-25). With chests on offer the slot is
           drawn at random for the player and recorded exactly as a tap would
           be, so the prize opens in a real chest and the other two are shown
           beside it. Never "no pick", never "the first one". */
        const slot = choosing ? randomPickSlot(offerSlots) : undefined;
        if (slot != null) {
          setLocalPick(slot);
          setLocalAutoPicked(true);
        }
        try {
          onBroadcastOpen?.(slot, slot != null);
        } catch {
          /* ignore */
        }
        runOpen(slot);
      }, winnerAutoOpenMs());
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
  }, [chestKey, phase, isWinner, runOpen, onBroadcastOpen, choosing, offerSlots]);

  // ── The pick countdown, shown to the revealer and the table alike ─────────
  useEffect(() => {
    if (!chestKey || phase !== 'locked') return;
    const started = Date.now();
    const windowMs = winnerAutoOpenMs();
    setSecondsLeft(Math.ceil(windowMs / 1000));
    const id = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((windowMs - (Date.now() - started)) / 1000)));
    }, 250);
    return () => clearInterval(id);
  }, [chestKey, phase]);

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
  /** The slot that holds this player's prize, as far as this seat knows. */
  const pickedSlot =
    data.choices?.find((c) => c.picked)?.slot ?? data.pickedSlot ?? localPick ?? null;
  /** Nobody chose: the window ran out (here or on the revealer's screen), or
   *  the server opened the chest itself. */
  const randomlyPicked = localAutoPicked || data.autoPicked === true || data.chosen === false;
  const opened = phase === 'opening' || phase === 'explosion' || phase === 'revealed';
  // Dan 2026-08-21: 'you should never have "50x the average bounty" — it's
  // just a random payout prize.' Mystery bounties are drawn from a prize
  // table; framing one as a multiple of the average implies the player earned
  // a ratio, which is not what happened. The figure stands on its own.

  return (
    <div
      className={`mbc mbc--${phase}${isJackpot ? ' mbc--jackpot' : ''}${
        pressed ? ' mbc--pressed' : ''
      }${choosing ? ' mbc--choosing' : ''}`}
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

        {/* ── PICK 1 OF 3 (Dan 2026-10-22) ── the sealed chests on offer. The
            revealer taps one; everyone else watches. The big chest above
            opens with the one that was picked. */}
        {choosing && (
          <div
            className={`mbc__picks${opened ? ' mbc__picks--opened' : ''}`}
            role="group"
            aria-label="Pick A Mystery Chest"
          >
            {Array.from({ length: offerSlots }, (_, i) => i + 1).map((slot) => {
              /* EVERY CHEST STAYS ON SCREEN (Dan 2026-10-25). The picked one
                 opens; once the award is revealed the other two open beside
                 it and show what they held. Until the server's answer lands
                 they stay sealed with a "?", never hidden. */
              const isPicked = pickedSlot === slot;
              const choice = data.choices?.find((c) => c.slot === slot);
              const showValue = phase === 'revealed';
              return (
                <button
                  key={slot}
                  type="button"
                  className={`mbc__pick${canTap ? ' mbc__pick--tappable' : ''}${
                    isPicked ? ' mbc__pick--picked' : ''
                  }${opened && !isPicked ? ' mbc__pick--other' : ''}${
                    showValue && choice ? ' mbc__pick--shown' : ''
                  }`}
                  onClick={() => handlePick(slot)}
                  disabled={!canTap}
                  aria-label={canTap ? `Pick Chest ${slot}` : `Mystery Chest ${slot}`}
                  style={{ ['--mbc-p' as string]: slot - 1 }}
                >
                  <span className="mbc__pick-glow" aria-hidden="true" />
                  {artOk ? (
                    <img className="mbc__pick-img" src={CHEST_IMG} alt="" draggable={false} />
                  ) : (
                    <span className="mbc__pick-css" aria-hidden="true" />
                  )}
                  <span className="mbc__pick-num">{slot}</span>
                  {showValue && (
                    <span className="mbc__pick-plate">
                      <span className="mbc__pick-plate-label">
                        {isPicked ? (isWinner ? 'Your Prize' : 'The Prize') : 'Could Have Been'}
                      </span>
                      <span
                        className={`mbc__pick-plate-amount${isPicked ? '' : ' mbc__other-amount'}`}
                      >
                        {choice ? figure(choice.amount) : isPicked ? figure(displayAmount) : '?'}
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* ── Prompt / status ── */}
        {phase === 'locked' && (
          <div className="mbc__prompt">
            {isWinner ? (
              <>
                <span className="mbc__prompt-main">
                  {choosing ? `Pick 1 Of ${offerSlots} Chests` : 'Tap The Chest To Open'}
                </span>
                <span className="mbc__prompt-sub">
                  {choosing ? 'Your Bounty Is Inside The One You Pick' : 'Your Bounty Is Inside'}
                </span>
                {choosing && (
                  <span className="mbc__countdown" aria-live="polite">
                    {secondsLeft}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="mbc__prompt-main mbc__prompt-main--waiting">
                  {choosing
                    ? `${data.knockerName} Is Picking A Chest`
                    : `${data.knockerName} Is Opening The Chest`}
                  <span className="mbc__dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
                <span className="mbc__prompt-sub">Watch The Reveal</span>
                {choosing && (
                  <span className="mbc__countdown" aria-hidden="true">
                    {secondsLeft}
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Reveal ── */}
        {phase === 'revealed' && (
          <div className="mbc__reveal">
            {/* PICK 1 OF 3: which chest held this prize. The server's record
                (the slot picked, or the one the self-opened chest stood in) is
                what every seat shows; the revealer's own tap fills the gap
                until it arrives. */}
            {choosing && pickedSlot != null && (
              <div className="mbc__picked-slot">
                {randomlyPicked
                  ? `Time Ran Out - Chest ${pickedSlot} Was Picked At Random`
                  : `${isWinner ? 'You Picked' : `${data.knockerName} Picked`} Chest ${pickedSlot}`}
              </div>
            )}
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
            {/* PICK 1 OF 3: the row of chests above now carries every amount,
                the prize and the two that could have been. This heading is the
                one line of words that points at them. */}
            {choosing && !data.choices && (
              <div className="mbc__others">
                <div className="mbc__others-head">Opening The Other Chests</div>
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
