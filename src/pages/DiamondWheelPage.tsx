import { useLiveBonusGuard } from '../hooks/useLiveBonusGuard';
import BonusReplayLibrary from '../components/games/BonusReplayLibrary';
import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
/** The player chooses an entry, then watches a committed server result open.
 * Free entries retain their welcome or claimed Daily Bonus identity. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useIsMounted } from '../hooks/useIsMounted';
import { useIdleSpinCountdown } from '../hooks/useIdleSpinCountdown';
import { useAutoSettle, useStandingRefresh } from '../hooks/useAutoSettle';
import PageSkeleton from '../components/common/PageSkeleton';
import { Modal } from '../components/common/Modal';
import { LoadingState } from '../components/common/EmptyState';
import { wheelPrizeTitle, WheelExperience } from '../components/wheel/WheelExperience';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { WheelCabinet, WheelEntry, WheelPrizeGallery } from '../components/wheel/WheelCabinet';
import { validSpinAmount } from '../utils/bonusGameBudget';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import DiamondWheelService, {
  type WheelWelcomeState,
  type WheelDailyBonusState,
  type WheelSegment,
  type WheelSpinResult,
  type WheelState,
  type WheelBonusAward,
} from '../services/DiamondWheelService';
import {
  randomClientSeed,
  verifyWheelReceiptFairness,
  type WheelFairnessVerdict,
} from '../utils/wheelFairness';
import { compactChips } from '../utils/format';
import TodayLine from '../components/games/TodayLine';
import { autoRunVerdict, cycleRunSize, type AutoRun } from '../utils/autoRun';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import FloorFeed from '../components/games/FloorFeed';
import { useGameFloor } from '../hooks/useGameFloor';
import styles from './diamondGames.module.css';
import wheelStyles from '../components/wheel/WheelCabinet.module.css';
import {
  assertWheelReceipt,
  clearWheelPending,
  readWheelPending,
  saveWheelPending,
  type WheelPendingSpin,
  type WheelSpinMode,
} from '../utils/wheelPendingSpin';

/** A prize as the player reads it. Chips under one stay exact: they ARE the prize. */
function prizeLabel(seg: WheelSpinResult['outcome']): string {
  return seg.kind === 'nothing' ? 'Nothing' : wheelPrizeTitle(seg);
}

function outcomeHeadline(result: WheelSpinResult): string {
  const o = result.secondary?.outcome ?? result.outcome;
  if (o.kind === 'nothing') return 'No Prize This Spin';
  return result.welcome ? `Welcome Spin: You Won ${prizeLabel(o)}` : `You Won ${prizeLabel(o)}`;
}

function historyTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A prize's worth in dollars: whole figures compact, a fraction exact (2.5 chips is $2.50, not $2). */
function worth(valueChips: number): string {
  return `$${Number.isInteger(valueChips) ? compactChips(valueChips) : valueChips.toFixed(2)}`;
}

const MAX_CLIENT_SEED = 64;

/**
 * THE ONE BLOCKER WITH A WAY OUT (2026-09-11). Every other reason the plate is
 * dead is the club's to fix or the clock's; this one is the player's, and it
 * used to be a dead end: the plate simply sat there disabled saying they were
 * short. Named once so the blocker and the door can never drift apart.
 */
const SHORT_OF_DIAMONDS = 'Not Enough Diamonds For A Spin';

/** Where a player buys diamonds. The same door the wallet's plate opens. */
const BUY_DIAMONDS = '/marketplace?tab=diamonds';

/**
 * AUTO SPIN (2026-09-11). Plinko has had Auto Drop and Crash Auto Play since
 * 2026-09-10; the wheel, which is the slowest of the three to press by hand,
 * had neither. Same plate, same runner, same one decision: press Spin when the
 * page would let a thumb press it, and stop the moment the page would stop one.
 *
 * The pause is longer than Plinko's 700ms and shorter than Crash's 1500ms. The
 * wheel's own landing already takes five seconds, and the prize sits under the
 * pointer at the end of it; this is the beat to read it, not to wait through.
 */
const AUTO_PAUSE_MS = 1200;

export default function DiamondWheelPage() {
  const { clubId: routeClubId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedBonus = searchParams.get('spin') === 'daily-bonus';
  const { user } = useAuthUser();
  const scopeRef = useRef('');
  scopeRef.current = `${user?.id ?? ''}:${routeClubId ?? ''}`;
  const toast = useToast();
  const isMountedRef = useIsMounted();
  const live = useCallback(() => isMountedRef.current, [isMountedRef]);

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [state, setState] = useState<WheelState | null>(null);
  const [welcomeState, setWelcome] = useState<WheelWelcomeState | null>(null);
  const welcome =
    welcomeState &&
    (state?.contract_version === 2 || state?.contract_version === 3) &&
    state.welcome
      ? {
          ...welcomeState,
          available: state.welcome.available,
          spin_price_diamonds: state.welcome.entry_diamonds,
          reason: state.welcome.available ? null : (welcomeState.reason ?? ('unfunded' as const)),
        }
      : welcomeState;
  /** The welcome spin is on offer: the plates, the odds and the next spin are welcome. */
  const [mode, setMode] = useState<WheelSpinMode>('paid');
  const welcomeMode = mode === 'welcome';
  const dailyBonusMode = mode === 'daily_bonus';
  const freeMode = mode !== 'paid';
  const [entryDiamonds, setEntryDiamonds] = useState(100);
  const entryRef = useRef(100);
  entryRef.current = freeMode ? 100 : entryDiamonds;
  const stateRead = useRef(0);
  const quotedEntry = useRef<number | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const [dailyBonus, setDailyBonus] = useState<WheelDailyBonusState | null>(null);
  const [dailyBonusError, setDailyBonusError] = useState(false);
  const [recovery, setRecovery] = useState<WheelPendingSpin | null>(null);
  // A spin whose answer never arrived is recovered by the page, never by a
  // press: the exact saved request is resent on useAutoSettle's schedule until
  // its receipt lands or the server refuses it.
  const [settleAttempts, setSettleAttempts] = useState(0);
  // A load, a next-spin preparation or a bonus-spin read that failed is tried
  // again by the page itself on the same schedule. Nobody is told to retry.
  const [loadFailures, setLoadFailures] = useState(0);
  const [loadTry, setLoadTry] = useState(0);
  const [prepareFailures, setPrepareFailures] = useState(0);
  const [bonusFailures, setBonusFailures] = useState(0);
  /* The face on the rim. It lags the offer by one spin on purpose: after the
     welcome spin lands, the prize it landed on stays under the pointer until
     the next spin starts, and only then does the paid table come round. */
  const [face, setFace] = useState<WheelSpinMode>('paid');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commit, setCommit] = useState<{ id: string; hash: string } | null>(null);
  const [clientSeed, setClientSeed] = useState<string>(() => randomClientSeed());
  const [spinning, setSpinning] = useState(false);
  const [autoSize, setAutoSize] = useState<number>(0);
  const [autoRun, setAutoRun] = useState<AutoRun | null>(null);
  const autoRunRef = useRef<AutoRun | null>(null);
  autoRunRef.current = autoRun;
  const [pending, setPending] = useState<WheelSpinResult | null>(null);
  const [lastResult, setLastResult] = useState<WheelSpinResult | null>(null);
  const [spinKey, setSpinKey] = useState(0);
  const [history, setHistory] = useState<WheelSpinResult[]>([]);
  const [verdict, setVerdict] = useState<WheelFairnessVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const busyRef = useRef(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [idleArmed, setIdleArmed] = useState(true);
  const [idleChoice, setIdleChoice] = useState(0);
  const [stageRef, stageWidth] = useMeasuredWidth<HTMLDivElement>(300);
  const { floor, refresh: refreshFloor } = useGameFloor(clubUuid, 20);

  const loadState = useCallback(
    async (uuid: string, stillCurrent: () => boolean = () => true) => {
      const scope = scopeRef.current;
      const request = ++stateRead.current;
      const entry = validSpinAmount(entryRef.current) ? entryRef.current : 100;
      const next = await DiamondWheelService.getStateV2(uuid, entry);
      if (!live() || !stillCurrent() || scopeRef.current !== scope || request !== stateRead.current)
        return next;
      quotedEntry.current = entry;
      setState(next);
      setWaitSeconds(next.player?.seconds_until_next ?? 0);
      return next;
    },
    [live]
  );

  const loadWelcome = useCallback(
    async (uuid: string) => {
      const scope = scopeRef.current;
      try {
        const next = await DiamondWheelService.welcomeState(uuid);
        if (live() && scopeRef.current === scope) setWelcome(next);
        return next;
      } catch (err) {
        reportError(err, 'DiamondWheelPage.welcome');
        return null;
      }
    },
    [live]
  );

  const loadDailyBonus = useCallback(
    async (uuid: string) => {
      const scope = scopeRef.current;
      try {
        const next = await DiamondWheelService.dailyBonusState(uuid);
        if (live() && scopeRef.current === scope) {
          setDailyBonus(next);
          setDailyBonusError(false);
          setBonusFailures(0);
        }
        return next;
      } catch (err) {
        reportError(err, 'DiamondWheelPage.dailyBonus');
        if (live() && scopeRef.current === scope) {
          setDailyBonus(null);
          setDailyBonusError(true);
          setBonusFailures((count) => count + 1);
        }
        return null;
      }
    },
    [live]
  );

  const freshCommit = useCallback(async () => {
    const scope = scopeRef.current;
    const c = await DiamondWheelService.commit();
    if (!live() || scopeRef.current !== scope) return;
    if (!c.ok) throw new Error('The Next Spin Ticket Could Not Be Prepared');
    setCommit({ id: c.commit_id, hash: c.server_seed_hash });
  }, [live]);

  const loadHistory = useCallback(
    async (uuid: string) => {
      const scope = scopeRef.current;
      try {
        /* ONE HISTORY (2026-09-11). The welcome spin is a row in wheel_spins
           like any other and carries its own `welcome` flag, so fn_wheel_history
           already returns it in order. There used to be a second read against
           wheel_free_spins and a merge; that table has not been written to
           since the welcome spin moved onto the real wheel, so the second read
           was a round trip for an empty array on every load. */
        const spins = await DiamondWheelService.history(uuid, 25);
        if (live() && scopeRef.current === scope) setHistory(spins);
      } catch (err) {
        reportError(err, 'DiamondWheelPage.history');
      }
    },
    [live]
  );

  /** Retire a consumed ticket before any asynchronous refresh. The next debit
   * needs both a new ticket and the new availability/balance quote. */
  const prepareNextSpin = useCallback(
    async (uuid: string) => {
      const scope = scopeRef.current;
      preparingRef.current = true;
      setPreparing(true);
      setPreparationError(null);
      setCommit(null);
      try {
        const next = await loadState(uuid);
        if (!live() || scopeRef.current !== scope) return;
        if (next.available) await freshCommit();
        if (live() && scopeRef.current === scope) setPrepareFailures(0);
      } catch (err) {
        reportError(err, 'DiamondWheelPage.prepare');
        if (live() && scopeRef.current === scope) {
          setPreparationError('Preparing Your Next Spin');
          setPrepareFailures((count) => count + 1);
        }
      } finally {
        if (live() && scopeRef.current === scope) {
          preparingRef.current = false;
          setPreparing(false);
        }
      }
    },
    [loadState, freshCommit, live]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!routeClubId || !user?.id) return;
      setLoading(true);
      setIdleArmed(true);
      busyRef.current = false;
      preparingRef.current = false;
      setPreparing(false);
      setPreparationError(null);
      setCommit(null);
      setLoadError(null);
      try {
        const uuid = await resolveClubUUID(routeClubId);
        if (cancelled || !live()) return;
        setClubUuid(uuid);
        const saved = readWheelPending(user.id, uuid);
        setRecovery(saved);
        setEntryDiamonds(saved?.entryDiamonds ?? 100);
        setAutoRun(null);
        setAutoSize(0);
        setPending(null);
        setSpinning(false);
        setLastResult(null);
        const [next, onTheHouse, bonus] = await Promise.all([
          loadState(uuid),
          loadWelcome(uuid),
          loadDailyBonus(uuid),
        ]);
        if (cancelled || !live()) return;
        const initialMode =
          saved?.mode ??
          (requestedBonus
            ? 'daily_bonus'
            : next.available && (next.welcome?.available ?? onTheHouse?.available)
              ? 'welcome'
              : (bonus?.ticket_count ?? 0) > 0
                ? 'daily_bonus'
                : 'paid');
        setMode(initialMode);
        setFace(initialMode);
        if (saved) {
          setCommit({ id: saved.commitId, hash: saved.commitHash });
          setClientSeed(saved.clientSeed);
        } else if (next.available) await freshCommit();
        void loadHistory(uuid);
        setLoadFailures(0);
      } catch (err) {
        reportError(err, 'DiamondWheelPage.load');
        if (!cancelled && live()) {
          setLoadError('Reconnecting To The Wheel');
          setLoadFailures((count) => count + 1);
        }
      } finally {
        if (!cancelled && live()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    routeClubId,
    user?.id,
    requestedBonus,
    live,
    loadState,
    loadWelcome,
    loadDailyBonus,
    freshCommit,
    loadHistory,
    loadTry,
  ]);
  useAutoSettle(loadFailures > 0, loadFailures, async () => {
    setLoadTry((count) => count + 1);
    return true;
  });

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const t = setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [waitSeconds]);

  useEffect(() => {
    const entry = freeMode ? 100 : entryDiamonds;
    if (
      !clubUuid ||
      (state?.contract_version !== 2 && state?.contract_version !== 3) ||
      !validSpinAmount(entry) ||
      quotedEntry.current === entry ||
      spinning ||
      recovery
    ) {
      setQuoting(false);
      return;
    }
    let current = true;
    setQuoting(true);
    void loadState(clubUuid, () => current)
      .then(async (next) => {
        // A lower stake can reopen a wheel that had no funded ticket on entry.
        if (current && next.available && !commit && !preparingRef.current) await freshCommit();
      })
      .catch((err) => {
        reportError(err, 'DiamondWheelPage.entry');
        if (current) setLoadError('The Spin Amount Could Not Be Loaded');
      })
      .finally(() => {
        if (current) setQuoting(false);
      });
    return () => {
      current = false;
    };
  }, [
    clubUuid,
    entryDiamonds,
    freeMode,
    state?.contract_version,
    spinning,
    recovery,
    loadState,
    commit,
    freshCommit,
  ]);

  const segments: WheelSegment[] = state?.segments ?? [];
  const welcomeSegments: WheelSegment[] = welcome?.segments ?? [];
  /* The odds follow the offer; the rim follows the last spin (see `face`). */
  const table =
    state?.contract_version === 2 || state?.contract_version === 3
      ? segments
      : welcomeMode
        ? welcomeSegments
        : dailyBonusMode
          ? (dailyBonus?.segments ?? segments)
          : segments;
  const rim =
    pending?.segments ??
    (state?.contract_version === 2 || state?.contract_version === 3
      ? segments
      : face === 'welcome'
        ? welcomeSegments
        : face === 'daily_bonus'
          ? (dailyBonus?.segments ?? segments)
          : segments);
  const cfg = state?.config;
  const player = state?.player;
  const price =
    recovery?.entryDiamonds ??
    (freeMode
      ? 100
      : state?.contract_version === 2 || state?.contract_version === 3
        ? entryDiamonds
        : (cfg?.spin_price_diamonds ?? 0));

  const blocker = useMemo<string | null>(() => {
    if (!state) return null;
    if (!user?.id) return 'Sign In To Spin';
    if (recovery) return null; // Receipt recovery must work even if the host has since closed.
    if (state.pending_awards?.length) return 'Opening Your Bonus Game';
    if (preparationError) return preparationError;
    if (!validSpinAmount(price)) return 'Choose 25 To 2,500 Whole Diamonds';
    if (
      quoting ||
      ((state.contract_version === 2 || state.contract_version === 3) &&
        quotedEntry.current !== price)
    )
      return 'Checking Your Spin';
    if (!state.available)
      return state.reason === 'not_configured'
        ? 'The Diamond Wheel Is Not Open Here Yet'
        : (state.contract_version === 2 || state.contract_version === 3) && state.reason
          ? state.reason
          : 'The Diamond Wheel Is Paused';
    if (state.frozen) return 'The Platform Is In Its Maintenance Break';
    if (player && !player.is_member) return 'Join The Club To Spin';
    if (dailyBonusMode)
      return dailyBonusError
        ? 'Reconnecting To Your Bonus Spins'
        : !dailyBonus
          ? 'Loading Bonus Spins'
          : !dailyBonus.available
            ? (dailyBonus.reason ?? 'Bonus Spins Are Unavailable')
            : null;
    if (welcomeMode) return welcome?.available ? null : 'Your Welcome Spin Is Unavailable'; // the house pays: no price, no limit, no purchased-only rule
    if (player && cfg && player.spins_today >= cfg.max_spins_per_player_per_day)
      return 'You Have Reached Today’s Spin Limit';
    if (player && player.spendable < price) {
      return cfg?.purchased_only && player.diamonds >= price
        ? 'This Wheel Spins Purchased Diamonds Only'
        : SHORT_OF_DIAMONDS;
    }
    return null;
  }, [
    state,
    quoting,
    welcome,
    player,
    cfg,
    price,
    welcomeMode,
    dailyBonusMode,
    dailyBonus,
    dailyBonusError,
    recovery,
    preparationError,
    user?.id,
  ]);

  // The pause between paid spins is the paid wheel's; a spin on the house does not wait for it.
  /** The only blocker a player can do something about, so the plate becomes the door. */
  const shortOfDiamonds = blocker === SHORT_OF_DIAMONDS;
  const running = autoRun !== null;

  /* Free entries cannot start a paid batch. The owner's visible 30-second
     countdown can consume one selected entry, then holds until another choice. */
  const cycleAuto = useCallback(() => {
    if (running || spinning || freeMode || recovery) return;
    setAutoSize(cycleRunSize);
    setIdleArmed(false);
    triggerHaptic('light');
  }, [running, spinning, freeMode, recovery]);

  const endAuto = useCallback(
    (why: string | null) => {
      if (!autoRunRef.current) return;
      setAutoRun(null);
      if (why) toast.info(why);
    },
    [toast]
  );

  const startAuto = useCallback(() => {
    if (!autoSize || running || spinning || freeMode || recovery) return;
    triggerHaptic('medium');
    setAutoRun({ total: autoSize, done: 0 });
  }, [autoSize, running, spinning, freeMode, recovery]);

  const stopAuto = useCallback(() => endAuto('Auto Spin Stopped'), [endAuto]);
  const canSpin = Boolean(
    clubUuid &&
    commit &&
    !spinning &&
    !preparing &&
    !blocker &&
    (recovery || welcomeMode || waitSeconds <= 0)
  );

  const handleSpin = useCallback(async () => {
    if (!user?.id || !clubUuid || !commit || busyRef.current || preparingRef.current || spinning)
      return;
    setIdleArmed(false);
    const scope = scopeRef.current;
    busyRef.current = true;
    setVerdict(null);
    setLastResult(null);
    triggerHaptic('medium');
    try {
      const attempt: WheelPendingSpin = recovery ?? {
        userId: user.id,
        clubId: clubUuid,
        mode,
        commitId: commit.id,
        commitHash: commit.hash,
        clientSeed: clientSeed.trim().slice(0, MAX_CLIENT_SEED) || randomClientSeed(),
        ticketId: dailyBonusMode ? (dailyBonus?.ticket_id ?? null) : null,
        ...(state?.contract_version === 2 || state?.contract_version === 3
          ? { contractVersion: state.contract_version, entryDiamonds: price }
          : {}),
      };
      saveWheelPending(attempt);
      setRecovery(attempt);
      const result =
        attempt.contractVersion === 2 || attempt.contractVersion === 3
          ? await DiamondWheelService.spinV2({ ...attempt, entryDiamonds: attempt.entryDiamonds! })
          : attempt.mode === 'daily_bonus'
            ? await DiamondWheelService.dailyBonusSpin(
                attempt.clubId,
                attempt.commitId,
                attempt.clientSeed,
                attempt.ticketId!
              )
            : attempt.mode === 'welcome'
              ? await DiamondWheelService.welcomeSpin(
                  attempt.clubId,
                  attempt.commitId,
                  attempt.clientSeed
                )
              : await DiamondWheelService.spin(
                  attempt.clubId,
                  attempt.commitId,
                  attempt.clientSeed
                );
      if (!live() || scopeRef.current !== scope) return;
      if (!result.ok) {
        clearWheelPending(attempt);
        setRecovery(null);
        void loadDailyBonus(clubUuid);
        toast.error(result.error || 'The Spin Was Refused');
        endAuto(autoRunRef.current ? 'Auto Spin Stopped' : null);
        if (welcomeMode) {
          /* The server said why (used, the pot is spent, the switch is off);
             the welcome state carries the same reason, so read it again and let
             the paid wheel back if the welcome spin is no longer on offer. */
          const next = await loadWelcome(clubUuid);
          if (live() && next && !next.available) {
            setMode('paid');
            setFace('paid');
          }
        }
        await prepareNextSpin(clubUuid);
        return;
      }
      assertWheelReceipt(result, attempt);
      // Keep the exact request durable until the whole prize reveal is complete.
      // A reload during either wheel replays its receipt without another debit.
      setFace(attempt.mode);
      setPending(result);
      setSpinKey((k) => k + 1);
      setSpinning(true);
      setSettleAttempts(0);
    } catch (err) {
      reportError(err, 'DiamondWheelPage.spin');
      endAuto(autoRunRef.current ? 'Auto Spin Stopped' : null);
      if (live() && scopeRef.current === scope) {
        // The saved request stays; useAutoSettle resends it.
        setSettleAttempts((count) => count + 1);
        toast.error('The Spin Is Not Confirmed Yet. Recovering Its Receipt');
      }
    } finally {
      if (scopeRef.current === scope) busyRef.current = false;
    }
  }, [
    clubUuid,
    commit,
    spinning,
    clientSeed,
    live,
    toast,
    freshCommit,
    welcomeMode,
    loadWelcome,
    loadDailyBonus,
    mode,
    dailyBonusMode,
    dailyBonus,
    recovery,
    state?.contract_version,
    price,
    user?.id,
    endAuto,
    prepareNextSpin,
  ]);

  const idleSeconds = useIdleSpinCountdown(
    idleArmed,
    !loading && canSpin && !recovery && !detailsOpen && !running && autoSize === 0,
    `${scopeRef.current}:${mode}:${entryDiamonds}:${idleChoice}`,
    () => {
      setIdleArmed(false);
      if (canSpin && !busyRef.current && !recovery) void handleSpin();
    }
  );

  const openBonus = useCallback(
    (award: WheelBonusAward) => {
      const awardId = encodeURIComponent(award.id);
      switch (award.game) {
        case 'plinko':
          navigate(`/clubs/${routeClubId}/plinko?wheelAward=${awardId}`);
          break;
        case 'crash':
          navigate(`/clubs/${routeClubId}/crash?wheelAward=${awardId}`);
          break;
        case 'crossing':
          navigate(`/clubs/${routeClubId}/crossing?wheelAward=${awardId}`);
          break;
        case 'mines':
          navigate(`/clubs/${routeClubId}/mines?wheelAward=${awardId}`);
          break;
        default: {
          // A game this build cannot route: a newer server-side game or a
          // malformed award. The server refuses new spins until it is finished
          // and the banked-game list is gone, so say why the control is held
          // instead of sitting on 'Opening Your Bonus Game' forever.
          const unrouted: never = award.game;
          reportError(
            new Error(`Wheel bonus game cannot be routed: ${String(unrouted)}`),
            'DiamondWheelPage.openBonus'
          );
          toast.error('Update The App To Open This Bonus Game.');
        }
      }
    },
    [navigate, routeClubId, toast]
  );

  // An unfinished entitlement is resumed immediately, never offered as a banked game.
  useEffect(() => {
    const award = state?.pending_awards?.[0];
    if (award && !spinning && !pending && !recovery && !loading) openBonus(award);
  }, [state?.pending_awards, spinning, pending, recovery, loading, openBonus]);

  const releaseNavigation = useLiveBonusGuard(
    spinning || Boolean(pending) || Boolean(recovery),
    () => toast.error('Wait For Your Spin To Finish.')
  );

  const handleLanded = useCallback(() => {
    if (!pending) return;
    const result = pending;
    if (recovery) {
      try {
        clearWheelPending(recovery);
      } catch (error) {
        reportError(error, 'DiamondWheelPage.clearReceipt');
      }
    }
    setRecovery(null);
    setPending(null);
    setSpinning(false);
    setLastResult(result);
    if (result.outcome.kind === 'nothing') triggerHaptic('light');
    else {
      toast.success(outcomeHeadline(result));
    }
    setClientSeed(randomClientSeed());
    setAutoRun((r) => (r ? { ...r, done: r.done + 1 } : r));
    if (result.welcome || result.daily_bonus) {
      setMode('paid');
      setAutoSize(0);
    }
    if (clubUuid) {
      void prepareNextSpin(clubUuid);
      void loadWelcome(clubUuid);
      void loadDailyBonus(clubUuid);
      void loadHistory(clubUuid);
      if (!result.welcome) void refreshFloor();
    }
    if (result.bonus) {
      releaseNavigation();
      endAuto(null);
      openBonus(result.bonus);
    }
  }, [
    releaseNavigation,
    endAuto,
    openBonus,
    recovery,
    pending,
    toast,
    clubUuid,
    loadState,
    loadWelcome,
    loadDailyBonus,
    loadHistory,
    freshCommit,
    refreshFloor,
    prepareNextSpin,
  ]);

  /* The runner. It presses Spin when the page would let a thumb press it: a
     fresh commit in hand, the pause between spins served, nothing blocking. It
     never decides an outcome and never presses while the wheel is turning, and
     it stops the moment the page would refuse a thumb (CLAUDE.md 10.12: the
     guard is the page's own blocker, not a watch built around it). */
  useEffect(() => {
    const verdict = autoRunVerdict(
      autoRun,
      { busy: spinning || pending !== null || preparing, blocker, ready: canSpin },
      AUTO_PAUSE_MS
    );
    if (verdict.kind === 'wait') return;
    if (verdict.kind === 'finished') {
      setAutoRun(null);
      toast.success(`Auto Spin Finished: ${autoRun?.total ?? 0} Spins`);
      return;
    }
    if (verdict.kind === 'blocked') {
      setAutoRun(null);
      toast.info(`Auto Spin Stopped: ${verdict.why}`);
      return;
    }
    const t = setTimeout(() => void handleSpin(), verdict.delayMs);
    return () => clearTimeout(t);
  }, [autoRun, spinning, pending, preparing, blocker, canSpin, handleSpin, toast]);

  useAutoSettle(
    Boolean(recovery) && !spinning && !pending && !loading && !loadError,
    settleAttempts,
    async () => {
      if (busyRef.current || preparingRef.current || !canSpin) return false;
      await handleSpin();
      return true;
    }
  );

  // A next spin that could not be prepared, and bonus spins that could not be
  // read, are tried again here. A saved spin always goes first: nothing is
  // prepared over it, so recovery never competes with a new wager.
  useAutoSettle(
    Boolean(preparationError) && !preparing && !spinning && !pending && !recovery && !loading,
    prepareFailures,
    async () => {
      if (!clubUuid || busyRef.current || preparingRef.current) return false;
      await prepareNextSpin(clubUuid);
      return true;
    }
  );
  useAutoSettle(dailyBonusError && !loading, bonusFailures, async () => {
    if (!clubUuid) return false;
    await loadDailyBonus(clubUuid);
    return true;
  });
  // Games paused by the platform come back by themselves after the break.
  useStandingRefresh(
    Boolean(state?.frozen) && !spinning && !pending && !recovery && !preparing && !loading,
    () => {
      if (clubUuid && !busyRef.current && !preparingRef.current) void prepareNextSpin(clubUuid);
    }
  );

  const refreshWheel = useCallback(async () => {
    if (!clubUuid || busyRef.current || spinning || preparingRef.current) return;
    endAuto(null);
    if (!recovery) {
      await prepareNextSpin(clubUuid);
    } else {
      // Refresh is read-only. An unknown spin keeps its exact durable identity;
      // only the page's own recovery resubmits that same idempotent request.
      const scope = scopeRef.current;
      preparingRef.current = true;
      setPreparing(true);
      try {
        await loadState(clubUuid);
      } catch (err) {
        reportError(err, 'DiamondWheelPage.refresh');
        if (live() && scopeRef.current === scope)
          toast.error('The Wheel Could Not Be Refreshed. Your Spin Is Still Saved.');
      } finally {
        if (live() && scopeRef.current === scope) {
          preparingRef.current = false;
          setPreparing(false);
        }
      }
    }
  }, [clubUuid, spinning, recovery, endAuto, prepareNextSpin, loadState, live, toast]);

  const handleVerify = useCallback(
    async (result: WheelSpinResult) => {
      setVerifying(true);
      try {
        const v = await verifyWheelReceiptFairness(
          result,
          result.welcome ? welcomeSegments : segments
        );
        if (!live()) return;
        setVerdict(v);
        if (v.fair) toast.success('This Spin Verifies');
        else toast.warning('This Spin Did Not Verify. Please Report It');
      } catch (err) {
        reportError(err, 'DiamondWheelPage.verify');
        if (live()) toast.error('The Check Could Not Run In This Browser');
      } finally {
        if (live()) setVerifying(false);
      }
    },
    [segments, welcomeSegments, live, toast]
  );

  if (loading) return <PageSkeleton />;
  if (loadError || !state) {
    return (
      <div className={`${styles.page} ${styles.fullscreenPage}`}>
        <LoadingState message={loadError || 'Reconnecting To The Wheel'} />
      </div>
    );
  }

  const spinLabel = spinning
    ? 'Spinning'
    : recovery
      ? 'Recovering Spin'
      : dailyBonusMode && !spinning
        ? 'Bonus Spin'
        : autoRun
          ? `Spin ${Math.min(autoRun.done + 1, autoRun.total)} Of ${autoRun.total}`
          : spinning
            ? 'Spinning'
            : welcomeMode
              ? 'Welcome Spin'
              : waitSeconds > 0
                ? `Ready In ${waitSeconds}s`
                : autoSize
                  ? `Auto Spin ${autoSize}`
                  : `Spin ${price.toLocaleString()}`;
  /* The run plate, the same one Plinko and Crash carry. The Odds plate it
     replaces was a scroll shortcut to a console that sits immediately below
     this one, and the wheel is the only one of the three that had it; the run
     is the control the other two put here and the wheel had nowhere. */
  const autoLabel = running ? 'Stop' : autoSize ? `Run ${autoSize}` : 'Run Off';
  const pill = preparing
    ? 'Checking'
    : preparationError
      ? 'Preparing'
      : dailyBonusMode
        ? 'Bonus Spin'
        : state.frozen
          ? 'Break'
          : state.available
            ? welcomeMode
              ? 'Welcome'
              : 'Open'
            : state.reason === 'not_configured'
              ? 'Closed'
              : 'Paused';
  const pillInk = state.frozen
    ? 'gold'
    : state.available
      ? welcomeMode
        ? 'gold'
        : 'green'
      : 'red';
  const wheelSize = Math.max(240, stageWidth);
  /* The welcome spin is once and for all, so the idle line says so rather than
     promising another one tomorrow (Dan 2026-09-10). */
  const welcomeNote =
    !welcomeMode && welcome?.enabled && state.available
      ? welcome.reason === 'used'
        ? ' You Have Had Your Welcome Spin.'
        : welcome.reason === 'pot_empty'
          ? ' The Welcome Spins Here Are Gone For Now.'
          : welcome.reason === 'unfunded'
            ? ''
            : welcome.reason === 'owner'
              ? ' The Club Pays The Welcome Spin, So Its Owner Does Not Take One.'
              : ''
      : '';
  const finalOutcome = lastResult?.secondary?.outcome ?? lastResult?.outcome;
  const readoutSubCopy = !lastResult
    ? ''
    : finalOutcome?.kind === 'nothing'
      ? 'This Previous Spin Had No Prize'
      : lastResult.bonus
        ? 'Your Awarded Game Is Ready'
        : finalOutcome?.kind === 'chips'
          ? 'Paid Into Your Club Chips'
          : finalOutcome?.kind === 'diamonds'
            ? 'Paid Into Your Diamonds'
            : 'Added To Your Account';

  return (
    <div className={`${styles.page} ${styles.fullscreenPage} ${wheelStyles.page}`}>
      <WheelCabinet
        eyebrow="Diamond Games"
        title="Diamond Spins"
        titleId="diamond-wheel-title"
        pill={pill}
        pillInk={pillInk}
        aria-labelledby="diamond-wheel-title"
        navigation={
          <>
            <button
              type="button"
              className={styles.back}
              disabled={spinning || running || Boolean(recovery) || autoSize > 0}
              aria-label={idleArmed ? 'Hold Automatic Spin' : 'Start 30 Second Spin Countdown'}
              onClick={() => setIdleArmed((value) => !value)}
            >
              {idleArmed ? `Hold ${idleSeconds}s` : 'Auto Held'}
            </button>
            <button
              type="button"
              className={styles.back}
              disabled={spinning || running}
              onClick={() => setDetailsOpen(true)}
            >
              Prizes & More
            </button>
            <button
              type="button"
              className={styles.back}
              disabled={spinning || preparing}
              onClick={() => void refreshWheel()}
            >
              {preparing ? 'Refreshing Wheel' : 'Refresh Wheel'}
            </button>
          </>
        }
        notice={
          blocker ? (
            <p role="status">{blocker}</p>
          ) : recovery ? (
            <p role="status">Recovering Your Previous Spin.</p>
          ) : lastResult && !spinning ? (
            <p role="status">{outcomeHeadline(lastResult)}</p>
          ) : null
        }
        setup={
          <>
            <nav aria-label="Spin Entry" className={wheelStyles.entryModes}>
              {(Boolean(welcome?.available) || (dailyBonus?.ticket_count ?? 0) > 0 || freeMode) && (
                <button
                  type="button"
                  className={styles.back}
                  disabled={spinning || running || Boolean(recovery)}
                  aria-pressed={mode === 'paid'}
                  onClick={() => {
                    setMode('paid');
                    setIdleArmed(true);
                    setIdleChoice((v) => v + 1);
                    setAutoSize(0);
                  }}
                >
                  Use Diamonds
                </button>
              )}
              {welcome?.available && (
                <button
                  type="button"
                  className={styles.back}
                  disabled={spinning || running || Boolean(recovery)}
                  aria-pressed={welcomeMode}
                  onClick={() => {
                    setMode('welcome');
                    setIdleArmed(true);
                    setIdleChoice((v) => v + 1);
                    setAutoSize(0);
                  }}
                >
                  Welcome Spin
                </button>
              )}
              {(dailyBonus?.ticket_count ?? 0) > 0 && (
                <button
                  type="button"
                  className={styles.back}
                  disabled={spinning || running || Boolean(recovery)}
                  aria-pressed={dailyBonusMode}
                  onClick={() => {
                    setMode('daily_bonus');
                    setIdleArmed(true);
                    setIdleChoice((v) => v + 1);
                    setAutoSize(0);
                  }}
                >
                  Bonus Spins ({dailyBonus?.ticket_count})
                </button>
              )}
            </nav>
            {(state.contract_version === 2 || state.contract_version === 3) && (
              <WheelEntry
                value={freeMode ? 100 : entryDiamonds}
                disabled={freeMode || spinning || running || Boolean(recovery)}
                onChange={(amount) => {
                  setEntryDiamonds(amount);
                  setIdleArmed(true);
                  setIdleChoice((v) => v + 1);
                }}
              />
            )}
          </>
        }
        bays={[
          { label: 'Diamonds', value: compactChips(player?.diamonds ?? 0), ink: 'blue' },
          { label: 'Club Chips', value: compactChips(player?.member_chips ?? 0), ink: 'silver' },
          freeMode
            ? { label: 'Spin', value: welcomeMode ? 'Welcome' : 'Bonus', ink: 'gold' }
            : { label: 'Spin', value: compactChips(price), ink: 'silver' },
          {
            label: 'Today',
            value: `${player?.spins_today ?? 0}/${cfg?.max_spins_per_player_per_day ?? 0}`,
            ink: 'muted',
          },
        ]}
        secondary={
          running
            ? { label: autoLabel, ink: 'red', onClick: stopAuto }
            : freeMode || recovery
              ? {
                  label: 'Prizes',
                  disabled: spinning,
                  onClick: () => setDetailsOpen(true),
                }
              : {
                  label: autoLabel,
                  ink: autoSize ? 'gold' : 'silver',
                  onClick: cycleAuto,
                  disabled: spinning,
                }
        }
        primary={
          shortOfDiamonds
            ? { label: 'Get Diamonds', ink: 'gold', onClick: () => navigate(BUY_DIAMONDS) }
            : running
              ? { label: spinLabel, ink: 'gold', disabled: true }
              : autoSize && !freeMode && !recovery
                ? { label: spinLabel, ink: 'gold', onClick: startAuto, disabled: !canSpin }
                : {
                    label: spinLabel,
                    ink: freeMode ? 'gold' : 'white',
                    onClick: handleSpin,
                    disabled: !canSpin,
                  }
        }
      >
        <div className={wheelStyles.stage} ref={stageRef}>
          <WheelExperience
            key={spinKey}
            receipt={pending}
            segments={rim}
            upgradeSegments={state.upgrade_segments ?? []}
            spinKey={spinKey}
            spinning={spinning}
            autoContinue={running}
            onFinished={handleLanded}
            fitViewport
            size={wheelSize}
          />
        </div>
      </WheelCabinet>

      <Modal
        isOpen={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title="Diamond Spins Details"
        className={wheelStyles.details}
        size="large"
      >
        <DiamondSpinsTabs clubId={routeClubId ?? ''} />
        <button
          type="button"
          className={styles.back}
          disabled={spinning || Boolean(recovery)}
          onClick={() => navigate('/bonuses')}
        >
          Daily Bonus Rewards
        </button>
        {lastResult && !spinning ? (
          <div className={styles.readout} role="status">
            <span className="sc-label sc-ink--blue">
              {finalOutcome?.kind === 'nothing' ? 'No Prize' : 'You Won'}
            </span>
            <span
              className={`${styles.readoutValue} ${finalOutcome?.kind === 'nothing' ? 'sc-ink--muted' : 'sc-ink--gold'}`}
            >
              {finalOutcome?.kind === 'nothing'
                ? 'Nothing'
                : prizeLabel(lastResult.secondary?.outcome ?? lastResult.outcome)}
            </span>
            <span className={`sc-copy ${styles.readoutSub}`}>{readoutSubCopy}</span>
          </div>
        ) : (
          <p className={`sc-copy sc-copy--center ${styles.readoutSub}`}>
            {spinning
              ? 'Your Spin Is Playing. Your Prize Opens Next.'
              : blocker
                ? 'Check The Spin Controls Below To Continue'
                : recovery
                  ? 'Your Previous Spin Is Being Recovered. Its Prize Opens Next.'
                  : dailyBonusMode
                    ? 'One Claimed Bonus Spin. 100 Diamond Value, No Diamonds Taken From You.'
                    : welcomeMode
                      ? `Your Welcome Spin, On The Club. A ${price.toLocaleString()} Diamond Spin On The Same Wheel, At No Cost To You, Once.`
                      : `Spin ${price.toLocaleString()} Diamonds.${state.contract_version === 2 || state.contract_version === 3 ? ' Every Spin Wins A Prize.' : ' Explore The Prizes Below.'}${welcomeNote}`}
          </p>
        )}
        <TodayLine
          used={player?.spins_today ?? 0}
          cap={cfg?.max_spins_per_player_per_day ?? 0}
          spentDiamonds={player?.diamonds_today ?? 0}
          noun="Spins"
          showCount={false}
        />
        <div>
          <WheelPrizeGallery segments={table} />
        </div>

        <SpadeConsole
          eyebrow="Provably Fair"
          title="Check Any Spin"
          plates={{
            secondary: {
              label: 'New Seed',
              onClick: () => setClientSeed(randomClientSeed()),
              disabled: spinning || Boolean(recovery),
            },
            primary: {
              label: verifying ? 'Checking' : 'Verify Spin',
              ink: 'white',
              onClick: () => lastResult && handleVerify(lastResult),
              disabled: verifying || !lastResult,
            },
          }}
        >
          <p className="sc-copy">
            Before You Spin, A Sealed Seed Commits To Your Draw. Afterward, Verify Spin Checks The
            Revealed Seed And Your Prize Against The Saved Wheel. An Upgrade Checks Both Draws.
          </p>
          <label className={styles.seedField}>
            <span className="sc-label sc-ink--blue">Your Client Seed</span>
            <input
              className={styles.seedInput}
              value={clientSeed}
              maxLength={MAX_CLIENT_SEED}
              onChange={(e) => setClientSeed(e.target.value)}
              disabled={spinning || Boolean(recovery)}
              spellCheck={false}
            />
          </label>
          <div className={styles.seedField}>
            <span className="sc-label sc-ink--blue">Next Spin Commitment</span>
            <code className={styles.mono}>{commit?.hash || 'Taking A Fresh Commitment'}</code>
          </div>
          {lastResult ? (
            /* The seeds are 64 hex characters: printed under their labels, not
             beside them, or the label column collapses to nothing. */
            <>
              <div className={styles.seedField}>
                <span className="sc-label sc-ink--blue">
                  {lastResult.welcome ? 'Server Seed (Welcome Spin)' : 'Server Seed'}
                </span>
                <code className={styles.mono}>{lastResult.fairness.server_seed}</code>
              </div>
              <div className={styles.seedField}>
                <span className="sc-label sc-ink--blue">Its Hash</span>
                <code className={styles.mono}>{lastResult.fairness.server_seed_hash}</code>
              </div>
              <div className={styles.seedField}>
                <span className="sc-label sc-ink--blue">Client Seed</span>
                <code className={styles.mono}>{lastResult.fairness.client_seed}</code>
              </div>
              <div className={`${styles.rows} ${styles.rowsCompact}`}>
                <div className={styles.row}>
                  <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Nonce</span>
                  <span className={`${styles.rowValue} sc-ink--silver`}>
                    {lastResult.fairness.nonce}
                  </span>
                </div>
                <div className={styles.row}>
                  <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Roll</span>
                  <code className={styles.mono}>{lastResult.fairness.roll.toLocaleString()}</code>
                </div>
                <div className={styles.row}>
                  <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Outcome</span>
                  <span className={`${styles.rowValue} sc-ink--silver`}>
                    {lastResult.outcome.label}
                  </span>
                </div>
                {verdict ? (
                  <p
                    className={`sc-copy sc-copy--center ${verdict.fair ? 'sc-ink--green' : 'sc-ink--red'}`}
                  >
                    {verdict.fair
                      ? 'Verified: The Hash, The Roll And The Outcome All Match'
                      : `Mismatch: Hash ${verdict.hashMatches ? 'Ok' : 'Differs'}, Roll ${verdict.rollMatches ? 'Ok' : 'Differs'}, Outcome ${verdict.outcomeMatches ? 'Ok' : 'Differs'}`}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="sc-copy sc-copy--center sc-ink--muted">
              Spin Once And The Revealed Seed Will Appear Here For You To Check.
            </p>
          )}
        </SpadeConsole>

        <FloorFeed
          wins={floor?.wins ?? []}
          game="wheel"
          eyebrow="The Floor"
          title="Recent Wins"
          limit={8}
        />

        {clubUuid && <BonusReplayLibrary clubId={clubUuid} />}

        <SpadeConsole eyebrow="Your Spins" title="History" foot="foot">
          {history.length === 0 ? (
            <p className="sc-copy sc-copy--center sc-ink--muted">No Spins Yet.</p>
          ) : (
            <div className={`${styles.rows} ${styles.rowsCompact}`}>
              {history.map((h) => (
                <div key={h.spin_id} className={styles.row}>
                  <span className={`${styles.rowLabel} sc-ink--silver`}>
                    {prizeLabel(h.secondary?.outcome ?? h.outcome)}
                    <span className={`${styles.rowMeta} sc-ink--muted`}>
                      {h.daily_bonus
                        ? `Daily Bonus Spin, ${historyTime(h.created_at)}`
                        : h.welcome
                          ? `Welcome Spin, ${historyTime(h.created_at)}`
                          : historyTime(h.created_at)}
                    </span>
                  </span>
                  <span
                    className={`${styles.rowValue} ${h.outcome.kind === 'nothing' ? 'sc-ink--muted' : 'sc-ink--gold'}`}
                  >
                    {h.outcome.kind === 'nothing'
                      ? '0'
                      : worth((h.secondary?.outcome ?? h.outcome).value_chips)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SpadeConsole>

        {!user ? <p className="sc-copy sc-copy--center sc-ink--muted">Sign In To Spin.</p> : null}
      </Modal>
    </div>
  );
}
