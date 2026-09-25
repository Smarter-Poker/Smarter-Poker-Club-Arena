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
import { useAutoSettle, useStandingRefresh } from '../hooks/useAutoSettle';
import PageSkeleton from '../components/common/PageSkeleton';
import { Modal } from '../components/common/Modal';
import { LoadingState } from '../components/common/EmptyState';
import { wheelPrizeTitle, WheelExperience } from '../components/wheel/WheelExperience';
import {
  WheelBonusQueue,
  WheelRunResume,
  WheelRunSummary,
  type WheelRunSummaryData,
} from '../components/wheel/WheelRunPanels';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { WheelCabinet, WheelEntry, WheelPrizeGallery } from '../components/wheel/WheelCabinet';
import { validSpinAmount } from '../utils/bonusGameBudget';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import DiamondWheelService, {
  CARD_NOT_PICKED,
  WheelReceiptUnverified,
  clearWheelPendingCard,
  readWheelPendingCard,
  saveWheelPendingCard,
  type WheelWelcomeState,
  type WheelDailyBonusState,
  type WheelSegment,
  type WheelSpinResult,
  type WheelState,
  type WheelBonusAward,
  type WheelCardAward,
  type WheelCardPick,
  type WheelPendingCard,
} from '../services/DiamondWheelService';
import { WheelCardTable, type WheelCardSlot } from '../components/wheel/WheelCardTable';
import {
  randomClientSeed,
  verifyWheelCardPick,
  verifyWheelReceiptFairness,
  type WheelCardVerdict,
  type WheelFairnessVerdict,
} from '../utils/wheelFairness';
import { compactChips } from '../utils/format';
import TodayLine from '../components/games/TodayLine';
import {
  autoRunVerdict,
  cycleRunSize,
  tallyWheelRun,
  wheelRunSoFar,
  WHEEL_RUN_SIZES,
  type WheelRun,
} from '../utils/autoRun';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { preloadDiamondGame } from '../utils/diamondGamePreload';
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
 *
 * THE RUN ACCUMULATES AND THE SERVER KEEPS IT (owner ruling 2026-09-21, R18).
 * A run is declared to the server before its first spin (`fn_wheel_run_begin`)
 * and closed after its last (`fn_wheel_run_end`). While it turns, every spin
 * lands on the run's tally instead of a reveal: instant prizes are already
 * paid by each spin's own transaction, and bonus games queue up unplayed. One
 * summary at the end lists all of it and plays the games one Play Game at a
 * time. A refresh mid-run finds the run open in `state.auto_run` and asks the
 * player to Resume or End it; nothing resumes by itself (R1).
 *
 * NOTHING ELSE ON THIS PAGE STARTS PLAY ON A CLOCK (owner ruling 2026-09-21,
 * R1). The 30-second idle countdown that used to press Spin is gone, and so is
 * the effect that opened an unfinished bonus game on load: that game now waits
 * in a card with a Play Game button. `tests/diamond-spins-never-start-themselves.law.test.tsx`.
 */
const AUTO_PAUSE_MS = 1200;

/**
 * A RECEIPT THAT WILL NOT VERIFY (2026-09-22). The server answered the spin and
 * this browser could not verify the answer, so money may have moved and the
 * saved spin is kept. The same bytes will not verify on a fourth send, so after
 * this many the page stops sending, lets the player go, and reads the wheel
 * again. The saved spin is sent again the next time the wheel opens.
 */
const RECEIPT_TRIES = 3;
const SPIN_SAVED = 'Your Last Spin Is Saved For The Next Time The Wheel Opens';

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
  // The spin request the page is sending, saved before it leaves so that a
  // lost answer is sent again with the same identity. Every spin has one while
  // its request is out, so it is not by itself a sign of recovery.
  const [recovery, setRecovery] = useState<WheelPendingSpin | null>(null);
  // The saved spin predates the attempt on the wire: it was found in storage
  // when the wheel opened, or an earlier send's answer was lost. Only then does
  // the wheel say it is recovering; an ordinary spin in flight is Spinning.
  const [priorSpin, setPriorSpin] = useState(false);
  const recovering = Boolean(recovery) && priorSpin;
  // Answers for the saved spin that this browser could not verify.
  const [receiptFailures, setReceiptFailures] = useState(0);
  const recoveryStopped = recovering && receiptFailures >= RECEIPT_TRIES;
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
  const [autoRun, setAutoRun] = useState<WheelRun | null>(null);
  const autoRunRef = useRef<WheelRun | null>(null);
  autoRunRef.current = autoRun;
  const running = autoRun !== null;
  /** A run is being declared or closed at the server: the plates wait for the answer. */
  const [runBusy, setRunBusy] = useState<'begin' | 'end' | false>(false);
  const runBusyRef = useRef(false);
  const [runSummary, setRunSummary] = useState<WheelRunSummaryData | null>(null);
  /* A close the server never answered. Nobody is told to refresh (the law a
     saved round settles itself): the page sends the same idempotent
     fn_wheel_run_end again on useAutoSettle's schedule until it lands. A close
     the server REFUSED is an answer, not this: the run stays open and its own
     End Run plate is on screen. */
  const [closeOwed, setCloseOwed] = useState<string | null>(null);
  const [closeFailures, setCloseFailures] = useState(0);
  const [pending, setPending] = useState<WheelSpinResult | null>(null);
  const [lastResult, setLastResult] = useState<WheelSpinResult | null>(null);
  const [spinKey, setSpinKey] = useState(0);
  const [history, setHistory] = useState<WheelSpinResult[]>([]);
  const [verdict, setVerdict] = useState<WheelFairnessVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  /**
   * THE THREE CARDS (owner ruling 2026-09-21, R15). A Diamonds outcome pays
   * nothing at the spin: it seals three cards worth half, double and triple
   * the diamonds risked and leaves a PENDING award that only a pick can
   * settle. `cardAward` is the award this page has open, `cardPick` the reveal
   * the server answered with, and `cardSending` the pick this browser saved
   * before sending, which is what goes again when an answer never arrives.
   */
  const [cardAward, setCardAward] = useState<WheelCardAward | null>(null);
  const [cardPick, setCardPick] = useState<WheelCardPick | null>(null);
  const [cardSending, setCardSending] = useState<WheelPendingCard | null>(null);
  const [cardPriorSend, setCardPriorSend] = useState(false);
  const [cardFailures, setCardFailures] = useState(0);
  const [cardVerdict, setCardVerdict] = useState<WheelCardVerdict | null>(null);
  const [cardVerifying, setCardVerifying] = useState(false);
  const cardBusyRef = useRef(false);
  /* Sent as often as a spin is, and then held: the same bytes will not verify
     on a later send, so the page stops, lets the player go, and sends the
     saved pick again the next time the wheel opens. The award stays pending at
     the server the whole time, so nothing is lost by waiting. */
  const cardHeld = cardPriorSend && cardFailures >= RECEIPT_TRIES;
  const [waitSeconds, setWaitSeconds] = useState(0);
  const busyRef = useRef(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const toastRef = useRef(toast);
  toastRef.current = toast;
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
      busyRef.current = false;
      runBusyRef.current = false;
      setRunBusy(false);
      setRunSummary(null);
      preparingRef.current = false;
      setPreparing(false);
      setPreparationError(null);
      setCommit(null);
      setLoadError(null);
      try {
        const uuid = await resolveClubUUID(routeClubId);
        if (cancelled || !live()) return;
        setClubUuid(uuid);
        /* A saved spin this build cannot read is discarded by the reader, out
           loud here, rather than failing the whole page: it could never be
           resubmitted anyway, and the History list still shows the spin if it
           ran. */
        const saved: WheelPendingSpin | null = readWheelPending(user.id, uuid, () =>
          toastRef.current.error('A Saved Spin Could Not Be Read. Your History Shows Every Spin.')
        );
        setRecovery(saved);
        setPriorSpin(Boolean(saved));
        setReceiptFailures(0);
        setSettleAttempts(0);
        setEntryDiamonds(saved?.entryDiamonds ?? 100);
        setAutoRun(null);
        setAutoSize(0);
        setPending(null);
        setSpinning(false);
        setLastResult(null);
        setCardAward(null);
        setCardPick(null);
        setCardVerdict(null);
        setCardSending(null);
        setCardPriorSend(false);
        setCardFailures(0);
        cardBusyRef.current = false;
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
        /* A pick this browser sent and never heard the answer to. Its award is
           the one the server still lists, so the SAME pick goes again on the
           page's own schedule; a saved pick whose award is no longer pending
           was already paid, so its slot is cleared rather than replayed. */
        const savedCard = readWheelPendingCard(user.id, uuid);
        if (savedCard) {
          if (next.pending_cards?.some((card) => card.award_id === savedCard.awardId)) {
            setCardSending(savedCard);
            setCardPriorSend(true);
          } else {
            clearWheelPendingCard(savedCard);
            toastRef.current.info('Your Diamond Card Was Already Paid');
          }
        }
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

  /* THE SERVER'S OWN LIST IS WHAT REOPENS A CARD GAME. A reload, a second tab
     and a return visit all find the pending award here, and a run that ended
     with one deals it as soon as its summary is closed. An award already open
     is never replaced, so a state read mid-pick cannot move the table. */
  useEffect(() => {
    const open = state?.pending_cards?.[0];
    if (open) setCardAward((current) => current ?? open);
  }, [state?.pending_cards]);

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
        // The quote (or the ticket it deals) for the chosen amount failed. It
        // used to set loadError, which nothing retried, so one failed read left
        // the page on a spinner for good. It is a next-spin preparation that
        // failed, so it joins that retry: the same amount, read again by the
        // page on useAutoSettle's schedule, with the chosen amount kept.
        if (current) {
          setPreparationError('Preparing Your Next Spin');
          setPrepareFailures((count) => count + 1);
        }
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
    // Receipt recovery must work even if the host has since closed. A saved spin
    // whose receipt would not verify holds the wheel until its next visit: a new
    // wager would take the one place that spin is saved.
    if (recovery) return recoveryStopped ? SPIN_SAVED : null;
    if (runBusy) return runBusy === 'begin' ? 'Setting Up Your Run' : 'Closing Your Run';
    /* The server accepts a run's spins while its games wait unplayed (R18); a
       run that is open at the server but not here is the player's to resume
       or end, and a game won by hand is played before another spin. */
    if (!running && state.auto_run) return 'Resume Or End Your Run Below';
    if (!running && state.pending_awards?.length) return 'Play Your Bonus Game Before Another Spin';
    /* The same refusal fn_wheel_spin_v2 gives, in the same words, so the plate
       and the server never disagree about why the wheel will not turn. */
    if (!running && state.pending_cards?.length)
      return 'Pick Your Diamond Card Before Another Spin';
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
    recoveryStopped,
    preparationError,
    user?.id,
    running,
    runBusy,
  ]);

  // The pause between paid spins is the paid wheel's; a spin on the house does not wait for it.
  /** The only blocker a player can do something about, so the plate becomes the door. */
  const shortOfDiamonds = blocker === SHORT_OF_DIAMONDS;

  /* Free entries cannot start a paid batch. */
  const cycleAuto = useCallback(() => {
    if (running || spinning || freeMode || recovery) return;
    setAutoSize((size) => cycleRunSize(size, WHEEL_RUN_SIZES));
    triggerHaptic('light');
  }, [running, spinning, freeMode, recovery]);

  /**
   * Close a run at the server and show what it won. Called once per run: the
   * ref is cleared first so a second caller (a refusal racing the runner's own
   * verdict) finds no run to close. The server's list of unplayed games is the
   * one the summary offers, because it also holds games from before a resume.
   */
  const closeRun = useCallback(
    async (run: WheelRun, why: string | null) => {
      const scope = scopeRef.current;
      runBusyRef.current = true;
      setRunBusy('end');
      let games = run.games;
      let cards: WheelCardAward[] = [];
      try {
        const closed = await DiamondWheelService.runEnd(run.runId);
        if (!live() || scopeRef.current !== scope) return;
        if (closed.ok) {
          games = closed.pending_awards;
          cards = closed.pending_cards;
          setCloseOwed(null);
          setCloseFailures(0);
        } else toast.error(closed.error || 'The Run Could Not Be Closed');
      } catch (err) {
        reportError(err, 'DiamondWheelPage.runEnd');
        if (live() && scopeRef.current === scope) {
          setCloseOwed(run.runId);
          setCloseFailures((count) => count + 1);
        }
      }
      if (!live() || scopeRef.current !== scope) return;
      if (clubUuid) {
        try {
          await loadState(clubUuid);
        } catch (err) {
          reportError(err, 'DiamondWheelPage.runState');
        }
      }
      if (!live() || scopeRef.current !== scope) return;
      runBusyRef.current = false;
      setRunBusy(false);
      if (why || run.prizes.length || games.length || cards.length || run.done > 0)
        setRunSummary({ total: run.total, done: run.done, why, prizes: run.prizes, games, cards });
      else if (why === null) toast.info('Auto Spin Stopped');
    },
    [clubUuid, live, loadState, toast]
  );

  const endAuto = useCallback(
    (why: string | null) => {
      const run = autoRunRef.current;
      if (!run) return;
      autoRunRef.current = null;
      setAutoRun(null);
      void closeRun(run, why);
    },
    [closeRun]
  );

  /** Declare the run to the server, then let the runner press. One press starts it (R1). */
  const startAuto = useCallback(async () => {
    if (!autoSize || running || spinning || freeMode || recovery) return;
    if (!clubUuid || runBusyRef.current || busyRef.current || state?.auto_run) return;
    const scope = scopeRef.current;
    runBusyRef.current = true;
    setRunBusy('begin');
    try {
      const begun = await DiamondWheelService.runBegin(clubUuid, autoSize);
      if (!live() || scopeRef.current !== scope) return;
      if (!begun.ok) {
        toast.error(begun.error || 'The Run Could Not Be Started');
        return;
      }
      triggerHaptic('medium');
      setAutoRun({
        runId: begun.run_id,
        total: begun.spins,
        done: begun.spins_done,
        prizes: [],
        games: [],
      });
    } catch (err) {
      reportError(err, 'DiamondWheelPage.runBegin');
      if (live() && scopeRef.current === scope) toast.error('The Run Could Not Be Started');
    } finally {
      if (live() && scopeRef.current === scope) {
        runBusyRef.current = false;
        setRunBusy(false);
      }
    }
  }, [autoSize, running, spinning, freeMode, recovery, clubUuid, state?.auto_run, live, toast]);

  /** The open run the server remembers: the player chooses, the page never resumes alone. */
  const resumeRun = useCallback(() => {
    const open = state?.auto_run;
    if (!open || running || spinning || recovery || runBusyRef.current || freeMode) return;
    triggerHaptic('medium');
    setAutoSize(open.spins);
    setAutoRun({
      runId: open.run_id,
      total: open.spins,
      done: open.spins_done,
      prizes: [],
      games: [],
    });
  }, [state?.auto_run, running, spinning, recovery, freeMode]);

  const endOpenRun = useCallback(() => {
    const open = state?.auto_run;
    if (!open || running || spinning || recovery || runBusyRef.current) return;
    void closeRun(
      { runId: open.run_id, total: open.spins, done: open.spins_done, prizes: [], games: [] },
      null
    );
  }, [state?.auto_run, running, spinning, recovery, closeRun]);

  const stopAuto = useCallback(() => endAuto('Auto Spin Stopped'), [endAuto]);
  const canSpin = Boolean(
    clubUuid &&
    commit &&
    !spinning &&
    !preparing &&
    !runBusy &&
    !blocker &&
    (recovery || welcomeMode || waitSeconds <= 0)
  );

  const handleSpin = useCallback(async () => {
    if (!user?.id || !clubUuid || !commit || busyRef.current || preparingRef.current || spinning)
      return;
    const scope = scopeRef.current;
    busyRef.current = true;
    setVerdict(null);
    setLastResult(null);
    triggerHaptic('medium');
    // Sending the saved spin again is a recovery. The first send of a new spin
    // is not, whatever happened to the spin before it.
    const resend = Boolean(recovery);
    setPriorSpin(resend);
    // The request may have left this browser, and the server answered it with
    // a body: from then on an error is a receipt that did not verify, not a
    // lost answer.
    let sent = false;
    let answered = false;
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
      sent = true;
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
        setPriorSpin(false);
        setReceiptFailures(0);
        setSettleAttempts(0);
        void loadDailyBonus(clubUuid);
        toast.error(result.error || 'The Spin Was Refused');
        endAuto(result.error || 'The Spin Was Refused');
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
      answered = true;
      assertWheelReceipt(result, attempt);
      // Keep the exact request durable until the whole prize reveal is complete.
      // A reload during either wheel replays its receipt without another debit.
      setFace(attempt.mode);
      /* THE WON GAME LOADS WHILE THE WHEEL IS STILL TURNING (2026-09-22). The
         reveal navigates the moment it finishes, so without this the game's
         chunk was fetched with the player already told what they had won.
         Starting the fetch here costs the spin nothing - the request leaves on
         the network and the wheel keeps its frames - and by the time the
         reveal ends the page is usually already in the module cache.
         The AWARD names the game, and nothing else does: handleLanded opens
         result.bonus, and assertWheelAward refuses any bonus or upgrade
         receipt that arrives without one, so a fallback to outcome.game or to
         the secondary wheel's outcome could never run. */
      preloadDiamondGame(result.bonus?.game);
      setPending(result);
      setSpinKey((k) => k + 1);
      setSpinning(true);
      setSettleAttempts(0);
      setReceiptFailures(0);
    } catch (err) {
      reportError(err, 'DiamondWheelPage.spin');
      endAuto('The Spin Is Not Confirmed');
      if (live() && scopeRef.current === scope) {
        if (!sent && !resend) {
          // The request could not be saved, and an unsaved spin is never sent.
          // Nothing left this browser, so there is nothing to recover.
          toast.error('This Device Could Not Save The Spin, So It Was Not Placed');
        } else if (answered || err instanceof WheelReceiptUnverified) {
          // The server answered and the answer did not verify. Money may have
          // moved, so the saved spin stays. It is sent again (a replay can carry
          // a clean copy), and after RECEIPT_TRIES answers like this the page
          // stops: the guard lets go, the wheel is read again, and the spin
          // waits for the next time the wheel opens.
          const failures = receiptFailures + 1;
          setReceiptFailures(failures);
          setPriorSpin(true);
          if (failures < RECEIPT_TRIES) {
            setSettleAttempts((count) => count + 1);
            if (!resend) toast.error('The Spin Is Not Confirmed Yet. Recovering Its Receipt');
          } else {
            toast.info(SPIN_SAVED);
            void loadState(clubUuid).catch((error) =>
              reportError(error, 'DiamondWheelPage.receiptHeld')
            );
          }
        } else {
          // No answer at all. The saved request stays; useAutoSettle resends it.
          setPriorSpin(true);
          setSettleAttempts((count) => count + 1);
          if (!resend) toast.error('The Spin Is Not Confirmed Yet. Recovering Its Receipt');
        }
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
    welcomeMode,
    loadWelcome,
    loadDailyBonus,
    loadState,
    mode,
    dailyBonusMode,
    dailyBonus,
    recovery,
    receiptFailures,
    state?.contract_version,
    price,
    user?.id,
    endAuto,
    prepareNextSpin,
  ]);

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

  /* An unfinished entitlement is warmed, never opened by an effect (R1). The
     wait it is held behind - a spin, a reveal, a receipt being recovered - is
     the fetch, so Play Game opens a scene that is already loaded. */
  useEffect(() => {
    const award = state?.pending_awards?.[0];
    if (award) preloadDiamondGame(award.game);
  }, [state?.pending_awards]);

  /** Play Game on the queue card or the run summary: a tap, then the game page. */
  const playAward = useCallback(
    (award: WheelBonusAward) => {
      if (spinning || pending || recovery || runBusyRef.current) return;
      setRunSummary(null);
      openBonus(award);
    },
    [spinning, pending, recovery, openBonus]
  );

  // Money in flight holds the page. A saved spin the page has stopped sending
  // does not: it waits for the next visit, and the player is free to go.
  const releaseNavigation = useLiveBonusGuard(
    spinning ||
      Boolean(pending) ||
      (Boolean(recovery) && !recoveryStopped) ||
      (Boolean(cardSending) && !cardHeld),
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
    setPriorSpin(false);
    setReceiptFailures(0);
    setPending(null);
    setSpinning(false);
    setLastResult(result);
    /* The result stays on screen in the reveal and the control panel notice;
       the slide-in toast that repeated it after every spin is gone (owner
       ruling 2026-09-21, R8). Inside a run there is no reveal to buzz, so the
       landing does. */
    if (result.outcome.kind === 'nothing') triggerHaptic('light');
    else if (autoRunRef.current) triggerHaptic('success');
    setClientSeed(randomClientSeed());
    setAutoRun((r) => (r ? tallyWheelRun(r, result, prizeLabel) : r));
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
    /* A game won by hand opens now: the player just tapped Play Game on its
       reveal. A game won inside a run waits on the run's tally and in the
       server's queue until the summary offers it (R9, R18). */
    if (result.bonus && !autoRunRef.current) {
      releaseNavigation();
      openBonus(result.bonus);
    }
    /* A card game won by hand opens now, on the plate the player just pressed.
       One won inside a run waits in the server's list until the run closes,
       exactly as a bonus game does (R9, R18). */
    if (result.outcome.cards && !autoRunRef.current) setCardAward(result.outcome.cards);
  }, [
    releaseNavigation,
    openBonus,
    recovery,
    pending,
    clubUuid,
    loadWelcome,
    loadDailyBonus,
    loadHistory,
    refreshFloor,
    prepareNextSpin,
  ]);

  /**
   * SEND ONE PICK, AND NEVER A SECOND, DIFFERENT ONE.
   *
   * The pick is saved before it leaves, so an answer that never arrives is
   * sent again with the identity the player chose. `fn_wheel_diamond_cards_pick`
   * is idempotent on the award, so a send that already landed answers with its
   * own reveal instead of taking another card: the replay pays nothing twice.
   *
   * A refusal the database ANSWERED is final, and the player never reads its
   * words. The page says one thing of its own and reads the wheel again; if
   * the award is still pending the table is still there, and if it is not, the
   * state that comes back says so.
   */
  const sendCardPick = useCallback(
    async (attempt: WheelPendingCard, resend: boolean) => {
      if (cardBusyRef.current) return;
      const scope = scopeRef.current;
      cardBusyRef.current = true;
      let sent = false;
      try {
        if (!resend) saveWheelPendingCard(attempt);
        setCardSending(attempt);
        setCardPriorSend(resend);
        sent = true;
        triggerHaptic('medium');
        const answer = await DiamondWheelService.pickCard(attempt.awardId, attempt.card);
        if (!live() || scopeRef.current !== scope) return;
        clearWheelPendingCard(attempt);
        setCardSending(null);
        setCardPriorSend(false);
        setCardFailures(0);
        if (!answer.ok) {
          toast.error(CARD_NOT_PICKED);
          if (clubUuid) await loadState(clubUuid);
          return;
        }
        setCardPick(answer.pick);
        triggerHaptic(answer.pick.paid_diamonds >= answer.pick.risk_diamonds ? 'success' : 'light');
        // The award is settled and the diamonds are in the wallet. Both are
        // read again when the table closes; this keeps the plate and the bay
        // honest in the meantime, so neither offers a spin the server refuses.
        setState((current) =>
          current
            ? {
                ...current,
                pending_cards: (current.pending_cards ?? []).filter(
                  (card) => card.award_id !== attempt.awardId
                ),
                ...(current.player
                  ? { player: { ...current.player, diamonds: answer.pick.balances.diamonds } }
                  : {}),
              }
            : current
        );
      } catch (err) {
        reportError(err, 'DiamondWheelPage.cardPick');
        if (!live() || scopeRef.current !== scope) return;
        if (!sent && !resend) {
          // Nothing left this browser, so there is nothing to recover.
          setCardSending(null);
          toast.error('This Device Could Not Save The Pick, So It Was Not Sent');
          return;
        }
        setCardPriorSend(true);
        setCardFailures((count) => count + 1);
      } finally {
        if (scopeRef.current === scope) cardBusyRef.current = false;
      }
    },
    [live, toast, clubUuid, loadState]
  );

  const pickCard = useCallback(
    (card: WheelCardSlot) => {
      if (!user?.id || !clubUuid || !cardAward || cardPick || cardSending) return;
      void sendCardPick(
        { userId: user.id, clubId: clubUuid, awardId: cardAward.award_id, card },
        false
      );
    },
    [user?.id, clubUuid, cardAward, cardPick, cardSending, sendCardPick]
  );

  /** The three values and the card that paid were sealed before the player chose. */
  const verifyCards = useCallback(async () => {
    if (!cardPick) return;
    setCardVerifying(true);
    try {
      const checked = await verifyWheelCardPick(cardPick);
      if (!live()) return;
      setCardVerdict(checked);
      if (checked.fair) toast.success('These Cards Verify');
      else toast.warning('These Cards Did Not Verify. Please Report It');
    } catch (err) {
      reportError(err, 'DiamondWheelPage.cardVerify');
      if (live()) toast.error('The Check Could Not Run In This Browser');
    } finally {
      if (live()) setCardVerifying(false);
    }
  }, [cardPick, live, toast]);

  /** Closing the table is the end of the card game: the wheel is read again. */
  const closeCards = useCallback(() => {
    setCardAward(null);
    setCardPick(null);
    setCardVerdict(null);
    if (!clubUuid) return;
    void prepareNextSpin(clubUuid);
    void loadHistory(clubUuid);
  }, [clubUuid, prepareNextSpin, loadHistory]);

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
      endAuto(null);
      return;
    }
    if (verdict.kind === 'blocked') {
      endAuto(verdict.why);
      return;
    }
    const t = setTimeout(() => void handleSpin(), verdict.delayMs);
    return () => clearTimeout(t);
  }, [autoRun, spinning, pending, preparing, blocker, canSpin, handleSpin, endAuto]);

  // Only a saved spin that predates the attempt is resent: while an ordinary
  // spin's first request is out there is nothing to recover yet, and polling
  // then let a resend jump the backoff the moment that request failed.
  useAutoSettle(
    recovering && !recoveryStopped && !spinning && !pending && !loading && !loadError,
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
  // A run close the server never answered is sent again by the page, never by
  // the player: fn_wheel_run_end is idempotent, so a lost answer costs nothing.
  useAutoSettle(
    Boolean(closeOwed) && !spinning && !pending && !loading,
    closeFailures,
    async () => {
      const runId = closeOwed;
      if (!runId || busyRef.current) return false;
      try {
        const closed = await DiamondWheelService.runEnd(runId);
        if (!live()) return true;
        if (closed.ok) {
          setCloseOwed(null);
          setCloseFailures(0);
          if (clubUuid) await loadState(clubUuid);
        } else {
          // An answer, even a refusal: the run's own plate owns it from here.
          setCloseOwed(null);
          setCloseFailures(0);
        }
      } catch (err) {
        reportError(err, 'DiamondWheelPage.runEndRetry');
        setCloseFailures((count) => count + 1);
      }
      return true;
    }
  );
  /* A PICK WHOSE ANSWER NEVER ARRIVED SETTLES ITSELF (the law a saved round
     settles itself). Nobody is told to check anything: the exact saved pick is
     sent again on useAutoSettle's schedule until its reveal lands, the server
     refuses it, or the page has sent it as often as it will. */
  useAutoSettle(
    Boolean(cardSending) && cardPriorSend && !cardHeld && !spinning && !pending && !loading,
    cardFailures,
    async () => {
      const attempt = cardSending;
      if (!attempt || cardBusyRef.current || busyRef.current) return false;
      await sendCardPick(attempt, true);
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
    if (!clubUuid || busyRef.current || spinning || preparingRef.current || runBusyRef.current)
      return;
    endAuto('Auto Spin Stopped');
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

  // An ordinary spin whose request is out reads Spinning, like the wheel turn
  // that follows it. Only a saved spin that predates this attempt recovers.
  const spinLabel =
    spinning || (recovery && !recovering)
      ? 'Spinning'
      : recoveryStopped
        ? 'Spin Saved'
        : recovering
          ? 'Recovering Spin'
          : dailyBonusMode && !spinning
            ? 'Bonus Spin'
            : autoRun
              ? `Spin ${Math.min(autoRun.done + 1, autoRun.total)} Of ${autoRun.total}`
              : runBusy
                ? 'One Moment'
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
          autoRun ? (
            <p role="status" data-run-tally>
              {`Spin ${Math.min(autoRun.done + 1, autoRun.total)} Of ${autoRun.total}. Won So Far: ${wheelRunSoFar(autoRun)}`}
            </p>
          ) : blocker ? (
            <p role="status">{blocker}</p>
          ) : recovering ? (
            <p role="status">Recovering Your Previous Spin.</p>
          ) : lastResult && !spinning ? (
            <p role="status">{outcomeHeadline(lastResult)}</p>
          ) : null
        }
        setup={
          <>
            {state.auto_run && !running && !recovery && !runBusy && (
              <WheelRunResume
                spins={state.auto_run.spins}
                spinsDone={state.auto_run.spins_done}
                busy={spinning || preparing}
                onResume={resumeRun}
                onEnd={endOpenRun}
              />
            )}
            {!running && !runSummary && (state.pending_awards?.length ?? 0) > 0 && (
              <WheelBonusQueue
                awards={state.pending_awards ?? []}
                disabled={spinning || Boolean(pending) || Boolean(recovery) || Boolean(runBusy)}
                onPlay={playAward}
              />
            )}
            <nav aria-label="Spin Entry" className={wheelStyles.entryModes}>
              {(Boolean(welcome?.available) || (dailyBonus?.ticket_count ?? 0) > 0 || freeMode) && (
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
            </nav>
            {(state.contract_version === 2 || state.contract_version === 3) && (
              <WheelEntry
                value={freeMode ? 100 : entryDiamonds}
                disabled={freeMode || spinning || running || Boolean(recovery)}
                onChange={(amount) => {
                  setEntryDiamonds(amount);
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
                ? {
                    label: spinLabel,
                    ink: 'gold',
                    onClick: () => void startAuto(),
                    disabled: !canSpin || Boolean(runBusy),
                  }
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
            receipt={pending}
            segments={rim}
            upgradeSegments={state.upgrade_segments ?? []}
            spinKey={spinKey}
            spinning={spinning}
            runMode={running}
            onFinished={handleLanded}
            fitViewport
            size={wheelSize}
          />
        </div>
      </WheelCabinet>

      {cardAward && !runSummary && !spinning && !pending && (
        <WheelCardTable
          award={cardAward}
          pick={cardPick}
          sending={cardSending ? cardSending.card : null}
          held={cardHeld}
          verdict={cardVerdict}
          verifying={cardVerifying}
          onPick={pickCard}
          onVerify={() => void verifyCards()}
          onClose={closeCards}
        />
      )}

      {runSummary && (
        <WheelRunSummary
          summary={runSummary}
          onPlay={playAward}
          onClose={() => setRunSummary(null)}
        />
      )}

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
            {spinning || (recovery && !recovering)
              ? 'Your Spin Is Playing. Your Prize Opens Next.'
              : blocker
                ? blocker
                : recovering
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
