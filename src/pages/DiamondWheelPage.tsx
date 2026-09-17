import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
/** The player chooses an entry, then watches a committed server result open.
 * Free entries retain their welcome or claimed Daily Bonus identity. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
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
  const o = result.outcome;
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
    welcomeState && state?.contract_version === 2 && state.welcome
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
  const [dailyBonus, setDailyBonus] = useState<WheelDailyBonusState | null>(null);
  const [dailyBonusError, setDailyBonusError] = useState(false);
  const [recovery, setRecovery] = useState<WheelPendingSpin | null>(null);
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
  const oddsRef = useRef<HTMLDivElement | null>(null);
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
        }
        return next;
      } catch (err) {
        reportError(err, 'DiamondWheelPage.dailyBonus');
        if (live() && scopeRef.current === scope) {
          setDailyBonus(null);
          setDailyBonusError(true);
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
    setCommit(c.ok ? { id: c.commit_id, hash: c.server_seed_hash } : null);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!routeClubId || !user?.id) return;
      setLoading(true);
      busyRef.current = false;
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
      } catch (err) {
        reportError(err, 'DiamondWheelPage.load');
        if (!cancelled && live()) setLoadError('The Wheel Could Not Be Loaded');
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
  ]);

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const t = setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [waitSeconds]);

  useEffect(() => {
    const entry = freeMode ? 100 : entryDiamonds;
    if (
      !clubUuid ||
      state?.contract_version !== 2 ||
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
      .catch((err) => {
        reportError(err, 'DiamondWheelPage.entry');
        if (current) setLoadError('The Spin Amount Could Not Be Checked');
      })
      .finally(() => {
        if (current) setQuoting(false);
      });
    return () => {
      current = false;
    };
  }, [clubUuid, entryDiamonds, freeMode, state?.contract_version, spinning, recovery, loadState]);

  const segments: WheelSegment[] = state?.segments ?? [];
  const welcomeSegments: WheelSegment[] = welcome?.segments ?? [];
  /* The odds follow the offer; the rim follows the last spin (see `face`). */
  const table =
    state?.contract_version === 2
      ? segments
      : welcomeMode
        ? welcomeSegments
        : dailyBonusMode
          ? (dailyBonus?.segments ?? segments)
          : segments;
  const rim =
    pending?.segments ??
    (state?.contract_version === 2
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
      : state?.contract_version === 2
        ? entryDiamonds
        : (cfg?.spin_price_diamonds ?? 0));

  const blocker = useMemo<string | null>(() => {
    if (!state) return null;
    if (!user?.id) return 'Sign In To Spin';
    if (recovery) return null; // Receipt recovery must work even if the host has since closed.
    if (!validSpinAmount(price)) return 'Choose 25 To 2,500 Whole Diamonds';
    if (quoting || (state.contract_version === 2 && quotedEntry.current !== price))
      return 'Checking Your Spin';
    if (!state.available)
      return state.reason === 'not_configured'
        ? 'The Diamond Wheel Is Not Open Here Yet'
        : state.contract_version === 2 && state.reason
          ? state.reason
          : 'The Diamond Wheel Is Paused';
    if (state.frozen) return 'The Platform Is In Its Maintenance Break';
    if (player && !player.is_member) return 'Join The Club To Spin';
    if (dailyBonusMode)
      return dailyBonusError
        ? 'Bonus Spins Could Not Be Loaded. Retry Below'
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
    user?.id,
  ]);

  // The pause between paid spins is the paid wheel's; a spin on the house does not wait for it.
  /** The only blocker a player can do something about, so the plate becomes the door. */
  const shortOfDiamonds = blocker === SHORT_OF_DIAMONDS;
  const running = autoRun !== null;

  /* A WELCOME SPIN IS NEVER AUTO-PLAYED. It is once per member, ever, and it
     costs nothing, so there is no run to make of it: the size cannot be set and
     a run cannot be started while the wheel is on the house. */
  const cycleAuto = useCallback(() => {
    if (running || spinning || freeMode || recovery) return;
    setAutoSize(cycleRunSize);
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
    clubUuid && commit && !spinning && !blocker && (recovery || welcomeMode || waitSeconds <= 0)
  );

  const handleSpin = useCallback(async () => {
    if (!user?.id || !clubUuid || !commit || busyRef.current || spinning) return;
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
        ...(state?.contract_version === 2
          ? { contractVersion: 2 as const, entryDiamonds: price }
          : {}),
      };
      saveWheelPending(attempt);
      setRecovery(attempt);
      const result =
        attempt.contractVersion === 2
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
        await freshCommit();
        return;
      }
      assertWheelReceipt(result, attempt);
      // Keep the exact request durable until the whole prize reveal is complete.
      // A reload during either wheel replays its receipt without another debit.
      setFace(attempt.mode);
      setPending(result);
      setSpinKey((k) => k + 1);
      setSpinning(true);
    } catch (err) {
      reportError(err, 'DiamondWheelPage.spin');
      endAuto(autoRunRef.current ? 'Auto Spin Stopped' : null);
      if (live() && scopeRef.current === scope)
        toast.error('The Spin Is Not Confirmed. Retry To Recover Its Receipt');
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
  ]);

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
      void loadState(clubUuid).catch((err) => reportError(err, 'DiamondWheelPage.reload'));
      void loadWelcome(clubUuid);
      void loadDailyBonus(clubUuid);
      void loadHistory(clubUuid);
      if (!result.welcome) void refreshFloor();
    }
    if (result.bonus) {
      endAuto(null);
      navigate(
        `/clubs/${routeClubId}/${result.bonus.game}?wheelAward=${encodeURIComponent(result.bonus.id)}`
      );
    }
    void freshCommit();
  }, [
    endAuto,
    navigate,
    routeClubId,
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
  ]);

  /* The runner. It presses Spin when the page would let a thumb press it: a
     fresh commit in hand, the pause between spins served, nothing blocking. It
     never decides an outcome and never presses while the wheel is turning, and
     it stops the moment the page would refuse a thumb (CLAUDE.md 10.12: the
     guard is the page's own blocker, not a watch built around it). */
  useEffect(() => {
    const verdict = autoRunVerdict(
      autoRun,
      { busy: spinning || pending !== null, blocker, ready: canSpin },
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
  }, [autoRun, spinning, pending, blocker, canSpin, handleSpin, toast]);

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
      <div className={`${styles.page} ${styles.fullscreenPage} ${wheelStyles.page}`}>
        <ErrorState
          message={loadError || 'The Wheel Could Not Be Loaded'}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const spinLabel = spinning
    ? 'Spinning'
    : recovery
      ? 'Recover Spin'
      : dailyBonusMode && !spinning
        ? 'Use Bonus Spin'
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
  const pill = dailyBonusMode
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
  const wheelSize = Math.max(240, Math.min(1000, stageWidth));
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
  const readoutSubCopy = !lastResult
    ? ''
    : lastResult.outcome.kind === 'nothing'
      ? 'This Previous Spin Had No Prize'
      : lastResult.bonus
        ? 'Your Awarded Game Is Ready'
        : lastResult.outcome.kind === 'chips'
          ? 'Paid Into Your Club Chips'
          : lastResult.outcome.kind === 'diamonds'
            ? 'Paid Into Your Diamonds'
            : 'Added To Your Account';

  return (
    <div className={`${styles.page} ${styles.fullscreenPage} ${wheelStyles.page}`}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(`/clubs/${routeClubId}/diamond-games`)}
      >
        ‹ Diamond Spins
      </button>

      <DiamondSpinsTabs clubId={routeClubId ?? ''} />
      <WheelCabinet
        eyebrow="Diamond Games"
        title="Diamond Spins"
        titleId="diamond-wheel-title"
        pill={pill}
        pillInk={pillInk}
        aria-labelledby="diamond-wheel-title"
        setup={
          state.contract_version === 2 ? (
            <WheelEntry
              value={freeMode ? 100 : entryDiamonds}
              disabled={freeMode || spinning || running || Boolean(recovery)}
              onChange={setEntryDiamonds}
            />
          ) : undefined
        }
        bays={[
          { label: 'Diamonds', value: compactChips(player?.diamonds ?? 0), ink: 'blue' },
          { label: 'Chips', value: compactChips(player?.member_chips ?? 0), ink: 'silver' },
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
                  onClick: () =>
                    oddsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
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
        <nav aria-label="Spin Entry" className={styles.rows}>
          <button
            type="button"
            className={styles.back}
            disabled={spinning || running || Boolean(recovery)}
            aria-pressed={mode === 'paid'}
            onClick={() => {
              setMode('paid');
              setAutoSize(0);
            }}
          >
            Paid Spin
          </button>
          {welcome?.available && (
            <button
              type="button"
              className={styles.back}
              disabled={spinning || running || Boolean(recovery)}
              aria-pressed={welcomeMode}
              onClick={() => {
                setMode('welcome');
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
                setAutoSize(0);
              }}
            >
              Bonus Spins ({dailyBonus?.ticket_count})
            </button>
          )}
          {dailyBonusError && (
            <button
              type="button"
              className={styles.back}
              disabled={spinning || Boolean(recovery)}
              onClick={() => clubUuid && void loadDailyBonus(clubUuid)}
            >
              Retry Bonus Spins
            </button>
          )}
          <button
            type="button"
            className={styles.back}
            disabled={spinning || Boolean(recovery)}
            onClick={() => navigate('/bonuses')}
          >
            Daily Bonus Rewards
          </button>
        </nav>
        <TodayLine
          used={player?.spins_today ?? 0}
          cap={cfg?.max_spins_per_player_per_day ?? 0}
          spentDiamonds={player?.diamonds_today ?? 0}
          noun="Spins"
          /* The Today bay already prints the count; this line carries the cost. */
          showCount={false}
        />
        <div className={styles.stage} ref={stageRef}>
          <WheelExperience
            key={spinKey}
            receipt={pending}
            segments={rim}
            spinKey={spinKey}
            spinning={spinning}
            autoContinue={running}
            onFinished={handleLanded}
            size={wheelSize}
          />
          {lastResult && !spinning ? (
            <div className={styles.readout} role="status">
              <span className="sc-label sc-ink--blue">
                {lastResult.outcome.kind === 'nothing' ? 'No Prize' : 'You Won'}
              </span>
              <span
                className={`${styles.readoutValue} ${lastResult.outcome.kind === 'nothing' ? 'sc-ink--muted' : 'sc-ink--gold'}`}
              >
                {lastResult.outcome.kind === 'nothing' ? 'Nothing' : prizeLabel(lastResult.outcome)}
              </span>
              <span className={`sc-copy ${styles.readoutSub}`}>{readoutSubCopy}</span>
            </div>
          ) : (
            <p className={`sc-copy sc-copy--center ${styles.readoutSub}`}>
              {blocker
                ? blocker
                : recovery
                  ? 'Your Previous Spin Needs Its Receipt. Recover It Before Starting Another.'
                  : dailyBonusMode
                    ? 'One Claimed Bonus Spin. 100 Diamond Value, No Diamonds Taken From You.'
                    : welcomeMode
                      ? `Your Welcome Spin, On The Club. A ${price.toLocaleString()} Diamond Spin On The Same Wheel, At No Cost To You, Once.`
                      : `Spin ${price.toLocaleString()} Diamonds.${state.contract_version === 2 ? ' Every Spin Wins A Prize.' : ' Explore The Prizes Below.'}${welcomeNote}`}
            </p>
          )}
        </div>
      </WheelCabinet>

      <div ref={oddsRef}>
        <WheelPrizeGallery segments={table} />
        {(state.pending_awards?.length ?? 0) > 0 && (
          <div className={styles.rows}>
            <h2>Your Ready Bonus Games</h2>
            {state.pending_awards?.map((award) => (
              <button
                key={award.id}
                type="button"
                className={styles.back}
                disabled={spinning || Boolean(recovery)}
                onClick={() =>
                  navigate(
                    `/clubs/${routeClubId}/${award.game}?wheelAward=${encodeURIComponent(award.id)}`
                  )
                }
              >
                Open{' '}
                {wheelPrizeTitle({
                  kind: 'bonus',
                  game: award.game,
                  ord: 0,
                  amount: award.base_diamonds,
                  label: '',
                  value_chips: 0,
                })}
              </button>
            ))}
          </div>
        )}
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

      <SpadeConsole eyebrow="Your Spins" title="History" foot="foot">
        {history.length === 0 ? (
          <p className="sc-copy sc-copy--center sc-ink--muted">No Spins Yet.</p>
        ) : (
          <div className={`${styles.rows} ${styles.rowsCompact}`}>
            {history.map((h) => (
              <div key={h.spin_id} className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--silver`}>
                  {prizeLabel(h.outcome)}
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
                  {h.outcome.kind === 'nothing' ? '0' : worth(h.outcome.value_chips)}
                </span>
              </div>
            ))}
          </div>
        )}
      </SpadeConsole>

      {!user ? <p className="sc-copy sc-copy--center sc-ink--muted">Sign In To Spin.</p> : null}
    </div>
  );
}
