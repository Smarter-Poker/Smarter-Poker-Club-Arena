import { useLiveBonusGuard } from '../hooks/useLiveBonusGuard';
import { pendingBonus, PriorBonusPending } from '../services/diamondBonusRecovery';
import { useAutoSettle, useStandingRefresh } from '../hooks/useAutoSettle';
import { useAwardAutoStart, useRefusedAward } from '../hooks/useAwardAutoStart';
import { useBonusBudget } from '../hooks/useBonusBudget';
import { useEarnedBonus } from '../hooks/useEarnedBonus';
import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
import BonusCompletion from '../components/games/BonusCompletion';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND CRASH - the player's page, on the console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A server-sealed crash point owns each round. New rounds preserve the
 * guaranteed minimum from the full funded entry; historical rounds retain
 * their original snapshot. Verification uses that same per-round contract.
 * The curve climbs as e^(0.12 t), with exact displayed-hundredth cash-outs.
 *
 * THE CLOCK IS THE SERVER'S. fn_crash_start seals the crash point and stamps
 * started_at; the page draws e^(k t) from that stamp (offset from the server's
 * own "now" in the same reply) and asks fn_crash_settle every few hundred
 * milliseconds what the round is. A cash-out is a server call, settled at the
 * displayed hundredth requested by the player, validated against the server clock and crash. An auto cash-out target
 * is honoured by the server the moment the curve passes it, whatever this tab
 * does afterwards, so a dropped connection cannot cost a planned exit.
 *
 * AUTO PLAY (2026-09-10). The steel plate sets a run (Run Off, Run 5, 10, 25,
 * 50) and the blue plate starts it (Auto Play 5); while it runs the steel
 * plate says Stop and the blue plate counts the round between climbs. A run
 * needs an auto cash-out, because the page will not be the one deciding when
 * to leave a climb. Every round in the run is its own server round with its
 * own sealed commit, started as the last one settles, and the run stops on
 * its own the moment a round is refused, the diamonds run out, the day's
 * limit is reached, or the player leaves the page.
 *
 * THE PICTURE (#ClubArenaConsole). The deck console: the curve on the glass,
 * five bays (Bet and Auto are controls - tap to change, the bay's ink is its
 * state), two plates. While a round is open the primary plate IS the cash-out,
 * printed in green with the live multiplier. Odds, fairness and history each
 * on their own console. Nothing is drawn but the curve and the seed line.
 *
 * THE GUARANTEE IS SHOWN BEFORE THE ROUND (Dan 2026-09-19, verbatim: "THEY
 * MUST ALL PAY A MINIMUM OF 1:1 VALUE EVEN IF THEY LOSE AND DON'T CASH OUT.
 * THAT SHOULD BE DISPLAYED BEFORE THEY EVEN START THE GAME"). The Guaranteed
 * bay and the status line print the floor a round pays on a crash before Start:
 * the server's own quote for a wheel award (a Super award, in gold, pays at
 * least the original spin value; an ordinary award a tenth), an open round's
 * sealed floor, or the tenth an ordinary entry keeps. The title is the game's
 * name from diamondGameTitle: Super Crash for a Super award, never "Upgraded".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { LoadingState } from '../components/common/EmptyState';
import CrashCurve, { type CrashPhase } from '../components/crash/CrashCurve';
import { GameConsole, GamePanel } from '../components/games/GameConsole';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import BonusSetup, { guaranteeCopy } from '../components/games/BonusSetup';
import {
  bonusTotal,
  bonusWalletDebit,
  gameChips,
  validBonusBudget,
} from '../utils/bonusGameBudget';
import { diamondBonusMinimum } from '../utils/diamondBonusPayout';
import { diamondGameTitle } from '../utils/diamondGameTitles';
import {
  DiamondBonusService,
  BonusRefusal,
  BonusUnreadable,
  BONUS_SAVED,
  type BonusStart,
} from '../services/DiamondBonusService';
import DiamondGamesService, {
  normaliseCrash,
  type CrashRound,
  type GameState,
} from '../services/DiamondGamesService';
import { randomClientSeed } from '../utils/wheelFairness';
import {
  multiplierLabel,
  crashMultiplierCents,
  verifyCrashRound,
  type CrashFairnessVerdict,
} from '../utils/diamondGamesFairness';
import { compactChips } from '../utils/format';
import TodayLine from '../components/games/TodayLine';
import SealedPrize from '../components/games/SealedPrize';
import { sealedChipPrize } from '../utils/sealedChipPrize';
import { autoRunVerdict, cycleRunSize, type AutoRun } from '../utils/autoRun';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import { soundService } from '../services/SoundService';
import FloorFeed from '../components/games/FloorFeed';
import CrashPointsStrip from '../components/games/CrashPointsStrip';
import { useGameFloor } from '../hooks/useGameFloor';
import styles from './diamondGames.module.css';

const MAX_CLIENT_SEED = 64;
const POLL_MS = 320;
/** The pause between a settled round and the next of a run, so the result can be read. */
const AUTO_PAUSE_MS = 1500;
/** The odds table's rows and the auto cash-out presets, in cents. 0 is Off. */

const AUTO_PRESETS = [0, 150, 200, 300, 500, 1000, 2000, 5000] as const;

/** A prize is an exact ledger amount, including all digits of large wins. */
function chipsLabel(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * THE ONE BLOCKER WITH A WAY OUT (2026-09-11). Every other reason the plate is
 * dead is the club's to fix or the clock's; this one is the player's, and it
 * used to be a dead end: the plate simply sat there disabled saying they were
 * short. Named once so the blocker and the door can never drift apart.
 */
const SHORT_OF_DIAMONDS = 'Not Enough Diamonds For That Bet';

/** Where a player buys diamonds. The same door the wallet's plate opens. */
const BUY_DIAMONDS = '/marketplace?tab=diamonds';

export default function DiamondCrashPage() {
  const { user } = useAuthUser();
  const { clubId } = useParams();
  return <DiamondCrashGame key={`${user?.id ?? ''}:${clubId ?? ''}`} />;
}
function DiamondCrashGame() {
  const { clubId: routeClubId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMountedRef = useIsMounted();
  const live = useCallback(() => isMountedRef.current, [isMountedRef]);

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [legacyState, setState] = useState<GameState | null>(null);
  const [quotedAmount, setQuotedAmount] = useState<number | null>(null);
  const stateGeneration = useRef(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commit, setCommit] = useState<{ id: string; hash: string } | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  // A load or a ticket deal that failed is tried again by the page itself, on
  // the same schedule as a saved wager. Nobody is told to retry or refresh.
  const [ticketFailures, setTicketFailures] = useState(0);
  const [loadFailures, setLoadFailures] = useState(0);
  const [loadTry, setLoadTry] = useState(0);
  const [quoteFailures, setQuoteFailures] = useState(0);
  const [quoteTry, setQuoteTry] = useState(0);
  const ticketInFlight = useRef<Promise<void> | null>(null);
  const [clientSeed, setClientSeed] = useState<string>(() => randomClientSeed());
  const [selectedBudget, setBudget] = useBonusBudget(routeClubId, 'crash');
  const earned = useEarnedBonus(clubUuid, 'crash', selectedBudget);
  const budget = earned.budget;
  const state = (earned.gameState as GameState | null) ?? legacyState;
  const bet = bonusTotal(budget);
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  // A wager whose answer never arrived. The page settles it on its own
  // schedule (useAutoSettle); the player is never asked to check anything.
  const [uncertain, setUncertain] = useState(false);
  const [settleAttempts, setSettleAttempts] = useState(0);
  // The server answered the saved wager BONUS_SENDS_PER_REQUEST times and this
  // browser could verify none of the answers. It stays saved (money may have
  // moved) and is sent again on the next visit; on this one nothing more is
  // sent for it and nothing holds the player.
  const [saved, setSaved] = useState(false);
  // The server refused a ticket that could no longer open a round and charged
  // nothing, so the same wager goes again on a fresh ticket - once per press.
  const [restartOwed, setRestartOwed] = useState(false);
  // The Double Down offer is a question about the player's own diamonds. A won
  // game never starts itself over it; it is treated as open until the setup
  // panel says otherwise.
  const [offerOpen, setOfferOpen] = useState(true);
  const heldStart = useRef<BonusStart | null>(null);
  // The exact wager the server refused for its ticket alone, auto cash-out
  // included. It goes again, unchanged but for the fresh ticket: never rebuilt
  // from what the page happens to show by then.
  const owed = useRef<BonusStart | null>(null);
  const [autoCents, setAutoCents] = useState<number>(0);
  const [round, setRound] = useState<CrashRound | null>(null);
  const [revealedRoundId, setRevealedRoundId] = useState<string | null>(null);
  const [phase, setPhase] = useState<CrashPhase>('idle');
  const [startedAtLocal, setStartedAtLocal] = useState<number | null>(null);
  const [liveCents, setLiveCents] = useState(100);
  const [starting, setStarting] = useState(false);
  const [cashing, setCashing] = useState(false);
  const [history, setHistory] = useState<CrashRound[]>([]);
  const [verdict, setVerdict] = useState<CrashFairnessVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [autoSize, setAutoSize] = useState<number>(0);
  /** A run in progress: how many rounds it is, how many have settled. */
  const [autoRun, setAutoRun] = useState<AutoRun | null>(null);
  const autoRunRef = useRef<AutoRun | null>(null);
  autoRunRef.current = autoRun;
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGeneration = useRef(0);
  const lastFinishedRound = useRef<string | null>(null);
  const busyRef = useRef(false);
  const roundRef = useRef<CrashRound | null>(null);
  roundRef.current = round;
  const [stageRef, stageWidth] = useMeasuredWidth<HTMLDivElement>(300);
  const { floor, refresh: refreshFloor } = useGameFloor(clubUuid, 20);

  // The multiplier must keep working even when WebGL cannot render the flight.
  // Freeze the displayed value while its exact cash-out request is pending.
  useEffect(() => {
    if (phase !== 'open' || !round || startedAtLocal === null || cashing) return;
    let frame = 0;
    const update = () => {
      setLiveCents(
        crashMultiplierCents(
          round.growth_k,
          Math.max(0, performance.now() - startedAtLocal),
          round.cap_cents
        )
      );
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [phase, round?.round_id, round?.growth_k, round?.cap_cents, startedAtLocal, cashing]);

  const loadState = useCallback(
    async (uuid: string) => {
      const generation = ++stateGeneration.current;
      setQuotedAmount(null);
      const amount = bonusTotal(budgetRef.current);
      const next = await DiamondGamesService.getState(uuid, 'crash', Math.min(amount, 5000));
      if (!live() || generation !== stateGeneration.current) return next;
      setState(next);
      setQuotedAmount(amount);
      setWaitSeconds(next.player?.seconds_until_next ?? 0);
      return next;
    },
    [live]
  );

  const freshCommit = useCallback(() => {
    if (ticketInFlight.current) return ticketInFlight.current;
    setTicketError(null);
    const request = (async () => {
      try {
        const c = await DiamondGamesService.commit('crash');
        if (!live()) return;
        if (
          !c.ok ||
          !/^[a-f0-9]{64}$/.test(c.server_seed_hash) ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c.commit_id)
        )
          throw new Error('The Game Ticket Could Not Be Loaded');
        setCommit({ id: c.commit_id, hash: c.server_seed_hash });
        setTicketFailures(0);
      } catch (error) {
        if (live()) {
          setCommit(null);
          setTicketError('Preparing Your Game');
          setTicketFailures((count) => count + 1);
        }
        throw error;
      } finally {
        ticketInFlight.current = null;
      }
    })();
    ticketInFlight.current = request;
    return request;
  }, [live]);

  const loadHistory = useCallback(
    async (uuid: string) => {
      try {
        const rows = await DiamondGamesService.crashHistory(uuid, 25);
        if (live()) setHistory(rows);
      } catch (err) {
        reportError(err, 'DiamondCrashPage.history');
      }
    },
    [live]
  );

  const stopPolling = useCallback(() => {
    pollGeneration.current++;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** A settled round: stop the clock, show the outcome, refresh everything. */
  const finish = useCallback(
    (settled: CrashRound) => {
      if (!live() || lastFinishedRound.current === settled.round_id) return;
      lastFinishedRound.current = settled.round_id;
      stopPolling();
      roundRef.current = settled;
      setRound(settled);
      const cashed = settled.status === 'cashed';
      setPhase(cashed ? 'cashed' : 'crashed');
      if (cashed) {
        /* The cash-out sings at the multiplier it got, the same voice the
           spin ladder uses for a multiplier result. A crash says nothing:
           silence after a climb is the loudest thing this game has. */
        soundService.playSpinMultiplierResult((settled.outcome?.cashout_cents ?? 100) / 100);
        triggerHaptic('success');
        toast.success(
          `Cashed Out At ${multiplierLabel(settled.outcome?.cashout_cents ?? 100)} For ${chipsLabel(settled.outcome?.payout_chips ?? 0)} Chips`
        );
      } else {
        triggerHaptic('light');
      }
      setClientSeed(randomClientSeed());
      setAutoRun((r) => (r ? { ...r, done: r.done + 1 } : r));
      if (clubUuid) {
        void loadState(clubUuid).catch((err) => reportError(err, 'DiamondCrashPage.reload'));
        void loadHistory(clubUuid);
        void refreshFloor();
      }
      /* The commit this round used is spent. Clear it before asking for the
         next, so nothing (the runner included) can press Start on a dead ticket. */
      setCommit(null);
      void freshCommit().catch((error) => reportError(error, 'DiamondCrashPage.nextTicket'));
    },
    [live, stopPolling, toast, clubUuid, loadState, loadHistory, freshCommit, refreshFloor]
  );

  /** Adopt an open round (fresh or resumed) and start asking the server about it. */
  const adopt = useCallback(
    (open: CrashRound) => {
      roundRef.current = open;
      setRound(open);
      setPhase('open');
      setStartedAtLocal(performance.now() - open.elapsed_ms);
      setLiveCents(open.multiplier_now_cents ?? 100);
      stopPolling();
      const generation = pollGeneration.current;
      const current = () =>
        live() &&
        pollGeneration.current === generation &&
        roundRef.current?.round_id === open.round_id &&
        roundRef.current.status === 'open';
      const tick = async () => {
        if (!current()) return;
        try {
          const next = await DiamondGamesService.crashSettle(open.round_id, false, open);
          if (!current()) return;
          if (next.ok && next.round_id !== open.round_id)
            throw new Error('The Crash Response Belongs To A Different Round');
          if (next.ok && next.status !== 'open') {
            finish(next);
            return;
          }
          if (next.frozen) {
            toast.info('The Platform Is In Its Maintenance Break. The Round Waits');
          }
        } catch (err) {
          reportError(err, 'DiamondCrashPage.tick');
        }
        if (current()) pollRef.current = setTimeout(tick, POLL_MS);
      };
      pollRef.current = setTimeout(tick, POLL_MS);
    },
    [stopPolling, live, finish, toast]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!routeClubId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const uuid = await resolveClubUUID(routeClubId);
        if (cancelled || !live()) return;
        setClubUuid(uuid);
        const pending = pendingBonus(user?.id ?? '', uuid, 'crash');
        if (pending) {
          heldStart.current = pending;
          setBudget(pending.budget);
          // The page shows the wager it is settling: its seed and its exit.
          setClientSeed(pending.seed);
          if (typeof pending.autoCashoutCents === 'number' && pending.autoCashoutCents > 0)
            setAutoCents(pending.autoCashoutCents);
          setUncertain(true);
        }
        const next = await loadState(uuid);
        if (cancelled || !live()) return;
        void loadHistory(uuid);
        if (!pending && next.open_round && next.open_round.status === 'open')
          adopt(next.open_round);
        setLoadFailures(0);
      } catch (err) {
        reportError(err, 'DiamondCrashPage.load');
        if (!cancelled && live()) {
          setLoadError('Reconnecting To Crash');
          setLoadFailures((count) => count + 1);
        }
      } finally {
        if (!cancelled && live()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeClubId, loadTry]);
  useAutoSettle(loadFailures > 0, loadFailures, async () => {
    setLoadTry((count) => count + 1);
    return true;
  });

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const t = setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [waitSeconds]);

  const cfg = state?.config;
  const player = state?.player;
  const bets = useMemo(() => state?.bets ?? [], [state]);
  const betOption = useMemo(() => bets.find((b) => b.bet_diamonds === bet), [bets, bet]);
  const rate = cfg?.diamonds_per_chip ?? 100;
  const capCents = betOption?.cap_cents ?? cfg?.max_multiplier_cents ?? 100000;
  const growthK = cfg?.growth_k ?? 0.12;
  const autoPresets = useMemo(
    () => AUTO_PRESETS.filter((t) => t === 0 || t <= capCents),
    [capCents]
  );
  const autoChoice = autoCents > capCents ? 0 : autoCents;
  const autoTarget = autoChoice > 0 ? autoChoice : null;

  const blocker = useMemo<string | null>(() => {
    if (!earned.ready)
      return (
        earned.error ??
        (earned.loading ? 'Checking Your Wheel Award' : 'Win Crash On Diamond Spins To Play')
      );
    if (!state) return null;
    if (!state.available)
      return state.reason === 'not_configured' ? 'Crash Is Not Open Here Yet' : 'Crash Is Paused';
    if (state.frozen) return 'The Platform Is In Its Maintenance Break';
    if (player && !player.is_member) return 'Join The Club To Play';
    if (player && cfg && player.rounds_today >= cfg.max_rounds_per_player_per_day)
      return 'You Have Reached Today’s Limit';
    if (betOption && !betOption.playable)
      return 'The Club Cannot Cover A Win At That Bet Right Now';
    if (player && player.spendable < bonusWalletDebit(budget)) {
      return cfg?.purchased_only && player.diamonds >= bonusWalletDebit(budget)
        ? 'Crash Takes Purchased Diamonds Only'
        : SHORT_OF_DIAMONDS;
    }
    return null;
  }, [state, player, cfg, bet, betOption, earned.ready, earned.error, earned.loading, budget]);
  // The blocker is the server's own state (a closed or paused game, the day's
  // limit, the wallet), never a transient flag such as a start in flight.
  const refusal = useRefusedAward(earned.award?.id, blocker !== null);
  /** One place decides what a refusal means; the start and the replay both land here. */
  const settleRefusal = (e: BonusRefusal, refused: BonusStart | null) => {
    if (e.ticketGone && refused) {
      // Only the ticket was refused and nothing was charged: the same wager
      // goes again on a fresh ticket, by itself.
      owed.current = refused;
      setRestartOwed(true);
      return;
    }
    // Anything else: read the award again so the page shows why, and let go of
    // the player until the server's reasons change.
    refusal.refuse(refused?.budget.award?.id);
    void earned.refresh();
  };
  const settleRefusalRef = useRef(settleRefusal);
  settleRefusalRef.current = settleRefusal;
  /** Stop sending a saved wager whose answers will not verify, let the player
   * go, and read the game again. */
  const keepForNextVisit = () => {
    setSaved(true);
    toast.info(BONUS_SAVED);
    void earned.refresh();
    if (clubUuid) {
      void loadState(clubUuid).catch((error) => reportError(error, 'DiamondCrashPage.saved'));
      void loadHistory(clubUuid);
    }
  };
  const keepForNextVisitRef = useRef(keepForNextVisit);
  keepForNextVisitRef.current = keepForNextVisit;

  const open = phase === 'open';
  const running = autoRun !== null;
  // An earned wheel award owns admission, even when direct-entry quoting is closed.
  // A failed preparation is tried again below on a widening schedule, never in
  // a tight loop and never by asking the player to press Retry.
  useEffect(() => {
    if (
      !loading &&
      earned.ready &&
      state?.available &&
      !state.frozen &&
      !commit &&
      !ticketError &&
      !uncertain &&
      !open &&
      !starting &&
      phase === 'idle'
    ) {
      void freshCommit().catch((error) => reportError(error, 'DiamondCrashPage.prepare'));
    }
  }, [
    loading,
    earned.ready,
    state?.available,
    state?.frozen,
    commit,
    ticketError,
    uncertain,
    open,
    starting,
    phase,
    freshCommit,
  ]);
  useAutoSettle(
    Boolean(ticketError) && !commit && !uncertain && !open && !loading,
    ticketFailures,
    async () => {
      await freshCommit().catch((error) => reportError(error, 'DiamondCrashPage.retryTicket'));
      return true;
    }
  );
  /** The only blocker a player can do something about, so the plate becomes the door. */
  const shortOfDiamonds = blocker === SHORT_OF_DIAMONDS;
  const canStart = Boolean(
    earned.ready &&
    clubUuid &&
    commit &&
    validBonusBudget(budget) &&
    quotedAmount === bet &&
    state?.available &&
    player?.is_member &&
    betOption?.playable &&
    !uncertain &&
    !open &&
    !starting &&
    !cashing &&
    !blocker &&
    waitSeconds <= 0
  );

  // A failed entry quote is read again on the same widening schedule, so Start
  // never sits on "Checking Your Entry" until somebody reloads the page.
  useEffect(() => {
    if (!clubUuid || !validBonusBudget(budget) || open || starting) return;
    let cancelled = false;
    loadState(clubUuid)
      .then(() => {
        if (!cancelled && live()) setQuoteFailures(0);
      })
      .catch((e) => {
        reportError(e, 'DiamondCrashPage.entryQuote');
        if (!cancelled && live()) setQuoteFailures((count) => count + 1);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubUuid, budget.base, budget.doubled, open, starting, loadState, quoteTry]);
  useAutoSettle(quoteFailures > 0 && !open && !starting, quoteFailures, async () => {
    setQuoteTry((count) => count + 1);
    return true;
  });

  const cycleAuto = useCallback(() => {
    if (open || starting || running) return;
    const i = autoPresets.indexOf(autoChoice as (typeof AUTO_PRESETS)[number]);
    setAutoCents(autoPresets[(i + 1) % autoPresets.length]);
    triggerHaptic('light');
  }, [open, starting, running, autoPresets, autoChoice]);

  const cycleRun = useCallback(() => {
    if (open || starting || running || earned.required || budget.award) return;
    setAutoSize(cycleRunSize);
    triggerHaptic('light');
  }, [open, starting, running, earned.required, budget.award]);

  /** The run ends: on the last round, on Stop, or on the first refusal. */
  const endRun = useCallback(
    (why: string | null) => {
      if (!autoRunRef.current) return;
      setAutoRun(null);
      if (why) toast.info(why);
    },
    [toast]
  );

  /** Starts the round the plate shows, or - given `resend` - re-sends exactly the
   * wager the server refused for its ticket, on the ticket now in hand. */
  const handleStart = useCallback(
    async (resend?: BonusStart) => {
      if (
        !clubUuid ||
        !commit ||
        busyRef.current ||
        open ||
        uncertain ||
        (!resend && (!canStart || !validBonusBudget(budget)))
      )
        return;
      busyRef.current = true;
      stateGeneration.current++;
      setQuotedAmount(null);
      setStarting(true);
      setVerdict(null);
      soundService.playSpinStart();
      triggerHaptic('medium');
      try {
        const seed = clientSeed.trim().slice(0, MAX_CLIENT_SEED) || randomClientSeed();
        const request: BonusStart = resend
          ? { ...resend, commitId: commit.id, serverSeedHash: commit.hash }
          : {
              clubId: clubUuid,
              game: 'crash' as const,
              budget: { ...budget },
              commitId: commit.id,
              serverSeedHash: commit.hash,
              seed,
              autoCashoutCents: autoTarget,
            };
        heldStart.current = request;
        const result = normaliseCrash(
          (await DiamondBonusService.start(request, user?.id ?? '')) as Record<string, unknown>
        );
        if (!live()) return;
        earned.consume(heldStart.current?.budget.award?.id);
        heldStart.current = null;
        setUncertain(false);
        if (!result.ok) {
          toast.error(result.error || 'The Round Was Refused');
          endRun(autoRunRef.current ? 'Auto Play Stopped' : null);
          await freshCommit();
          void loadState(clubUuid).catch(() => undefined);
          return;
        }
        if (result.status !== 'open') {
          finish(result);
          return;
        }
        adopt(result);
      } catch (err) {
        reportError(err, 'DiamondCrashPage.start');
        if (err instanceof PriorBonusPending) {
          // Another tab's wager is still saved: it settles first, by itself.
          heldStart.current = err.prior;
          if (live()) {
            setBudget(err.prior.budget);
            setUncertain(true);
            setSettleAttempts(0);
            toast.info('Settling Your Previous Round First');
          }
        } else if (err instanceof BonusRefusal) {
          // Nothing was charged. The ticket is spent either way, so a fresh one
          // is dealt; when the ticket itself was the refusal the same wager is
          // sent again on it.
          const refused = heldStart.current;
          heldStart.current = null;
          setCommit(null);
          if (live()) {
            setUncertain(false);
            toast.error(err.message);
            settleRefusalRef.current(err, refused);
            await freshCommit().catch((error) =>
              reportError(error, 'DiamondCrashPage.refusedTicket')
            );
          }
        } else if (err instanceof BonusUnreadable && err.final) {
          if (live()) {
            setUncertain(true);
            keepForNextVisitRef.current();
          }
        } else if (live()) {
          // The answer never arrived. The saved wager is replayed by
          // useAutoSettle until the server says what happened.
          setUncertain(true);
          setSettleAttempts(0);
          toast.info('Settling Your Round');
        }
        endRun(autoRunRef.current ? 'Auto Play Stopped' : null);
      } finally {
        busyRef.current = false;
        if (live()) setStarting(false);
      }
    },
    [
      clubUuid,
      user?.id,
      commit,
      canStart,
      open,
      clientSeed,
      budget,
      uncertain,
      autoTarget,
      live,
      toast,
      freshCommit,
      loadState,
      finish,
      adopt,
      endRun,
      setBudget,
    ]
  );

  const checkStart = async (): Promise<boolean> => {
    if (busyRef.current) return false;
    if (!heldStart.current) {
      // Nothing saved to replay: the round, if one opened, is on the server.
      if (clubUuid) {
        try {
          const next = await loadState(clubUuid);
          if (live() && next.open_round?.status === 'open') adopt(next.open_round);
          if (live()) setUncertain(false);
        } catch (err) {
          reportError(err, 'DiamondCrashPage.reread');
          if (live()) setSettleAttempts((count) => count + 1);
        }
      }
      return true;
    }
    busyRef.current = true;
    setStarting(true);
    try {
      const result = normaliseCrash(
        (await DiamondBonusService.start(heldStart.current, user?.id ?? '')) as Record<
          string,
          unknown
        >
      );
      if (!live()) return true;
      earned.consume(heldStart.current?.budget.award?.id);
      heldStart.current = null;
      setUncertain(false);
      if (result.status === 'open') adopt(result);
      else finish(result);
      setSettleAttempts(0);
    } catch (err) {
      reportError(err, 'DiamondCrashPage.checkStart');
      if (err instanceof BonusRefusal) {
        const refused = heldStart.current;
        heldStart.current = null;
        setCommit(null);
        if (live()) {
          setUncertain(false);
          setSettleAttempts(0);
          toast.error(err.message);
          settleRefusalRef.current(err, refused);
          await freshCommit().catch((error) =>
            reportError(error, 'DiamondCrashPage.recoveryTicket')
          );
        }
      } else if (err instanceof BonusUnreadable && err.final) {
        if (live()) keepForNextVisit();
      } else if (live()) {
        // Not an answer: the page tries again on its own schedule.
        setSettleAttempts((count) => count + 1);
      }
    } finally {
      busyRef.current = false;
      if (live()) setStarting(false);
    }
    return true;
  };
  // Nothing is replayed behind the skeleton or the load-error screen, where the
  // exit guard is off: the saved wager waits until the game itself is on screen.
  useAutoSettle(
    uncertain && !saved && !loading && !loadError && Boolean(state),
    settleAttempts,
    checkStart
  );
  // A wager the server refused for its ticket alone is sent again on the
  // fresh ticket, once, without the player pressing Start twice.
  const handleStartRef = useRef(handleStart);
  handleStartRef.current = handleStart;
  const restarts = useRef(0);
  useEffect(() => {
    // The owed wager is re-sent as it was, auto cash-out included; only the
    // server decides whether it can still start (a refusal now settles like
    // any other).
    if (!restartOwed || !commit || uncertain || starting || open) return;
    setRestartOwed(false);
    const wager = owed.current;
    owed.current = null;
    if (!wager || restarts.current >= 2) return;
    restarts.current += 1;
    void handleStartRef.current(wager);
  }, [restartOwed, commit, uncertain, starting, open]);
  // A won game starts itself: a short visible countdown, then the same Start
  // the plate would have pressed. Changing the entry or the auto cash-out
  // starts the window again. Auto Play stays off for an award, as before.
  const autoStartIn = useAwardAutoStart(
    earned.award?.id,
    canStart &&
      !restartOwed &&
      !offerOpen &&
      !loading &&
      phase === 'idle' &&
      !autoRun &&
      !refusal.refused,
    `${bet}:${autoChoice}:${clientSeed}:${refusal.opening}`,
    () => void handleStartRef.current()
  );
  // Games paused by the platform come back by themselves after the break.
  useStandingRefresh(Boolean(state?.frozen) && !open && !starting && !uncertain, () => {
    void earned.refresh();
    if (clubUuid)
      void loadState(clubUuid).catch((error) => reportError(error, 'DiamondCrashPage.break'));
  });

  const startRun = useCallback(() => {
    if (!autoSize || running || open || starting || earned.required || budget.award) return;
    if (!autoTarget) {
      toast.info('Set An Auto Cash Out First. Auto Play Cashes Out For You');
      return;
    }
    triggerHaptic('medium');
    setAutoRun({ total: autoSize, done: 0 });
  }, [autoSize, running, open, starting, autoTarget, toast, earned.required, budget.award]);

  const stopRun = useCallback(() => endRun('Auto Play Stopped'), [endRun]);

  /* The runner. It presses Start when the page would let a thumb press it:
     a fresh commit in hand, the last round settled, the pause between rounds
     served, nothing blocking. Every round it starts carries the auto cash-out
     that was set when the run began; the server settles it, not this page. */
  useEffect(() => {
    const verdict = autoRunVerdict(
      autoRun,
      { busy: open || starting || cashing, blocker, ready: canStart },
      AUTO_PAUSE_MS
    );
    if (verdict.kind === 'wait') return;
    if (verdict.kind === 'finished') {
      setAutoRun(null);
      toast.success(`Auto Play Finished: ${autoRun?.total ?? 0} Rounds`);
      return;
    }
    if (verdict.kind === 'blocked') {
      setAutoRun(null);
      toast.info(`Auto Play Stopped: ${verdict.why}`);
      return;
    }
    const t = setTimeout(() => void handleStart(), verdict.delayMs);
    return () => clearTimeout(t);
  }, [autoRun, open, starting, cashing, blocker, canStart, handleStart, toast]);

  const handleCashOut = useCallback(async () => {
    const current = roundRef.current;
    if (
      !current ||
      current.status !== 'open' ||
      phase !== 'open' ||
      busyRef.current ||
      liveCents < 101
    )
      return;
    busyRef.current = true;
    setCashing(true);
    triggerHaptic('heavy');
    try {
      const next = await DiamondGamesService.crashSettle(
        current.round_id,
        true,
        current,
        liveCents
      );
      if (!live()) return;
      if (!next.ok) {
        toast.error(next.error || 'The Cash Out Was Refused');
        return;
      }
      if (next.round_id !== current.round_id)
        throw new Error('The Crash Response Belongs To A Different Round');
      if (next.status === 'open') {
        toast.info('The Round Is Waiting Out The Maintenance Break');
        return;
      }
      finish(next);
    } catch (err) {
      reportError(err, 'DiamondCrashPage.cashout');
      if (live()) toast.error('The Cash Out Could Not Be Confirmed. Checking Your Round');
    } finally {
      busyRef.current = false;
      if (live()) setCashing(false);
    }
  }, [phase, live, toast, finish, liveCents]);

  const handleVerify = useCallback(
    async (r: CrashRound) => {
      if (
        !r.fairness.server_seed ||
        r.fairness.roll === undefined ||
        r.fairness.crash_cents === undefined
      )
        return;
      setVerifying(true);
      try {
        const v = await verifyCrashRound({
          serverSeed: r.fairness.server_seed,
          serverSeedHash: r.fairness.server_seed_hash,
          clientSeed: r.fairness.client_seed,
          nonce: r.fairness.nonce,
          roll: r.fairness.roll,
          crashCents: r.fairness.crash_cents,
          betChips: r.bet_chips,
          minimumPayoutChips: r.minimum_payout_chips ?? 0,
        });
        if (r.status === 'cashed' && r.outcome?.cashout_cents) {
          const prize = await sealedChipPrize({
            serverSeed: r.fairness.server_seed,
            clientSeed: r.fairness.client_seed,
            nonce: r.fairness.nonce,
            betChips: r.bet_chips,
            multiplierCents: r.outcome.cashout_cents,
            roundingStep: r.outcome.cashout_cents,
          });
          v.fair =
            v.fair &&
            prize === r.outcome.payout_chips &&
            r.outcome.cashout_cents <= Math.min(r.cap_cents, r.fairness.crash_cents);
        } else if (r.status === 'crashed') {
          v.fair = v.fair && r.outcome?.payout_chips === (r.minimum_payout_chips ?? 0);
        }
        if (!live() || busyRef.current || roundRef.current?.round_id !== r.round_id) return;
        setVerdict(v);
        if (v.fair) toast.success('This Round Verifies');
        else toast.warning('This Round Did Not Verify. Please Report It');
      } catch (err) {
        reportError(err, 'DiamondCrashPage.verify');
        if (live() && !busyRef.current && roundRef.current?.round_id === r.round_id)
          toast.error('The Check Could Not Run In This Browser');
      } finally {
        if (live()) setVerifying(false);
      }
    },
    [live, toast]
  );

  // The hold is armed only while the game is on screen: the skeleton and the
  // error screen offer no way to finish a bonus, so they must not hold the
  // player on a page that cannot progress. The award stays pending server-side
  // and the wheel reopens it.
  useLiveBonusGuard(
    !loading &&
      !loadError &&
      Boolean(state) &&
      // A wager kept for the next visit has nothing in flight: it holds nothing.
      !saved &&
      // A won game holds the page only while it can actually start: an award
      // this page cannot start (daily limit, a closed or paused game, a
      // cooldown) never traps the player on it. Money in flight still holds.
      ((Boolean(earned.award) && canStart && phase === 'idle' && !refusal.refused) ||
        starting ||
        open ||
        cashing ||
        uncertain),
    () => toast.error('Finish Your Bonus Game Before Leaving.')
  );
  if (loading) return <PageSkeleton />;
  if (loadError || !state) {
    return (
      <div className={`${styles.page} ${styles.fullscreenPage}`}>
        <LoadingState message={loadError || 'Reconnecting To Crash'} />
      </div>
    );
  }

  const chartWidth = Math.max(240, Math.min(1440, stageWidth - 4));
  const settledRound = round && round.status !== 'open' ? round : null;
  const finalCents = settledRound
    ? settledRound.status === 'cashed'
      ? (settledRound.outcome?.cashout_cents ?? 100)
      : (settledRound.outcome?.crash_cents ?? 100)
    : null;
  const readoutInk =
    phase === 'crashed' ? 'sc-ink--red' : phase === 'cashed' ? 'sc-ink--gold' : 'sc-ink--white';
  const readoutLabel =
    phase === 'crashed'
      ? 'Crashed At'
      : phase === 'cashed'
        ? 'Cashed Out At'
        : open
          ? 'Climbing'
          : 'Ready';
  const readoutValue =
    phase === 'idle' ? '1x' : multiplierLabel(open ? liveCents : (finalCents ?? 100));
  const liveWorth = open && round ? (round.bet_chips * liveCents) / 100 : 0;
  /* A run cannot start on a wheel award (startRun refuses it), so a size left
     over from ordinary play must not dress the plate or the readout as one. */
  const runSize = budget.award ? 0 : autoSize;
  const startLabel = starting
    ? 'Starting'
    : autoRun
      ? `Round ${Math.min(autoRun.done + 1, autoRun.total)} Of ${autoRun.total}`
      : waitSeconds > 0
        ? `Ready In ${waitSeconds}s`
        : autoStartIn !== null
          ? `Starting In ${autoStartIn}s`
          : runSize
            ? `Auto Play ${runSize}`
            : `Start ${bet.toLocaleString()}`;
  const runLabel = running ? 'Stop' : runSize ? `Run ${runSize}` : 'Run Off';
  const boost = (round ? round.bonus?.boost_multiplier === 2 : budget.award?.boostMultiplier === 2)
    ? 2
    : 1;
  const title = diamondGameTitle('crash', boost);
  /** The tenth an ordinary entry keeps, from the client mirror of the server's rule. */
  const standardFloor = (() => {
    if (budget.award || !validBonusBudget(budget)) return null;
    try {
      return diamondBonusMinimum(bet / rate, 1);
    } catch {
      return null;
    }
  })();
  /**
   * The floor the Guaranteed bay prints and the glass draws: the sealed floor
   * of the round on the table, else the server's quote for the award about to
   * start, else the sealed floor of the round just played at this same entry,
   * else the tenth an ordinary entry keeps. Null while the award is checked.
   */
  const guaranteed =
    open && round
      ? {
          chips: round.minimum_payout_chips ?? 0,
          betChips: round.bet_chips,
          super: round.bonus?.boost_multiplier === 2,
        }
      : earned.quote
        ? {
            chips: earned.quote.minimumPayoutChips,
            betChips: bet / rate,
            super: earned.quote.guarantee === 'super',
          }
        : settledRound &&
            !settledRound.award_id &&
            !budget.award &&
            settledRound.bet_diamonds === bet
          ? {
              chips: settledRound.minimum_payout_chips ?? 0,
              betChips: settledRound.bet_chips,
              super: false,
            }
          : earned.ready && !earned.award && standardFloor !== null
            ? { chips: standardFloor, betChips: bet / rate, super: false }
            : null;
  /** The sentence read before Start: what this round pays whatever happens. */
  const promise = earned.quote
    ? guaranteeCopy('crash', earned.quote)
    : earned.ready && !earned.award && standardFloor !== null
      ? guaranteeCopy('crash', { guarantee: 'standard', minimumPayoutChips: standardFloor })
      : null;
  const pill = open
    ? 'Live'
    : state.frozen
      ? 'Break'
      : state.available
        ? 'Open'
        : state.reason === 'not_configured'
          ? 'Closed'
          : 'Paused';
  const pillInk = open ? 'green' : state.frozen ? 'gold' : state.available ? 'green' : 'red';
  const roundAuto = round?.auto_cashout_cents ?? null;

  return (
    <div className={`${styles.page} ${styles.fullscreenPage}`}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(`/clubs/${routeClubId}/diamond-games`)}
      >
        ‹ Diamond Spins
      </button>

      <DiamondSpinsTabs clubId={routeClubId ?? ''} />
      <GameConsole
        setup={
          !open && (
            <BonusSetup
              game="crash"
              guarantee={earned.quote}
              budget={budget}
              entryReady={earned.ready}
              awardLoading={earned.loading}
              awardError={earned.error}
              onChange={setBudget}
              onOffer={setOfferOpen}
              diamonds={player?.spendable ?? null}
              disabled={starting || cashing || running || uncertain || restartOwed}
              clubId={routeClubId ?? ''}
            />
          )
        }
        eyebrow="Diamond Spins"
        title={title}
        titleId="diamond-crash-title"
        pill={pill}
        pillInk={pillInk}
        aria-labelledby="diamond-crash-title"
        bays={[
          {
            label: 'Bet',
            value: open && round ? compactChips(round.bet_diamonds) : compactChips(bet),
            ink: betOption && !betOption.playable ? 'red' : 'white',
            disabled: true,
          },
          {
            label: 'Guaranteed',
            value: guaranteed ? `${gameChips(guaranteed.chips)} Chips` : 'Pending',
            ink: guaranteed?.super ? 'gold' : undefined,
          },
          {
            label: 'Auto',
            value: open
              ? roundAuto
                ? multiplierLabel(roundAuto)
                : 'Off'
              : autoTarget
                ? multiplierLabel(autoTarget)
                : 'Off',
            ink: (open ? roundAuto : autoTarget) ? 'gold' : 'muted',
            onPress: cycleAuto,
            pressLabel: 'Change Auto Cash Out',
            disabled: open || starting || running,
          },
          { label: 'Diamonds', value: compactChips(player?.diamonds ?? 0), ink: 'blue' },
          { label: 'Chips', value: compactChips(player?.member_chips ?? 0), ink: 'silver' },
        ]}
        secondary={
          earned.required || budget.award
            ? {
                label: 'Spin The Wheel',
                onClick: () => navigate(`/clubs/${routeClubId}/wheel`),
                disabled: open || starting,
              }
            : running
              ? { label: runLabel, ink: 'red', onClick: stopRun }
              : {
                  label: runLabel,
                  ink: runSize ? 'gold' : 'silver',
                  onClick: cycleRun,
                  disabled: open || starting,
                }
        }
        primary={
          // A round that is OPEN keeps its cash-out plate whatever the wallet
          // says: the money is already on the table and getting it back is not
          // something a shortage may stand in front of.
          uncertain
            ? {
                label: saved ? 'Round Saved' : 'Settling',
                onClick: () => undefined,
                disabled: true,
              }
            : open
              ? {
                  label: cashing ? 'Booking Win' : 'Book The Win',
                  ink: 'green',
                  onClick: handleCashOut,
                  disabled: cashing || liveCents < 101,
                }
              : shortOfDiamonds
                ? { label: 'Get Diamonds', ink: 'gold', onClick: () => navigate(BUY_DIAMONDS) }
                : running
                  ? { label: startLabel, ink: 'gold', disabled: true }
                  : runSize
                    ? { label: startLabel, ink: 'gold', onClick: startRun, disabled: !canStart }
                    : {
                        label: startLabel,
                        ink: 'white',
                        onClick: () => void handleStart(),
                        disabled: !canStart,
                      }
        }
      >
        <TodayLine
          used={player?.rounds_today ?? 0}
          cap={cfg?.max_rounds_per_player_per_day ?? 0}
          spentDiamonds={player?.diamonds_today ?? 0}
          noun="Rounds"
        />
        <div className={`${styles.stage} ${styles.crashStage}`} ref={stageRef}>
          <CrashPointsStrip points={floor?.crash_points ?? []} />
          <div className={styles.board}>
            <CrashCurve
              phase={phase}
              growthK={round?.growth_k ?? growthK}
              capCents={round?.cap_cents ?? capCents}
              startedAtLocalMs={startedAtLocal}
              finalCents={finalCents}
              crashCents={settledRound?.outcome?.crash_cents ?? null}
              cashoutCents={settledRound?.outcome?.cashout_cents ?? null}
              autoCashoutCents={open ? roundAuto : autoTarget}
              tickerCents={open ? liveCents : null}
              minimumPayoutChips={guaranteed?.chips ?? null}
              betChips={guaranteed?.betChips ?? null}
              onSettled={() => {
                if (settledRound) setRevealedRoundId(settledRound.round_id);
              }}
              width={chartWidth}
              height={Math.max(310, Math.min(620, Math.round(chartWidth * 0.64)))}
            />
          </div>
          <div className={styles.readout} role="status">
            <span className="sc-label sc-ink--blue">{readoutLabel}</span>
            <span className={`${styles.readoutValue} ${styles.readoutCompact} ${readoutInk}`}>
              {readoutValue}
            </span>
            <span className={`sc-copy ${styles.readoutSub}`}>
              {open
                ? `Worth ${chipsLabel(liveWorth)} Chips Right Now`
                : saved
                  ? BONUS_SAVED
                  : settledRound
                    ? settledRound.status === 'cashed'
                      ? `${chipsLabel(settledRound.outcome?.payout_chips ?? 0)} Chips Paid${settledRound.outcome?.settled_by === 'time' ? ' By Your Auto Cash Out' : ''}`
                      : `Crashed At ${multiplierLabel(settledRound.outcome?.crash_cents ?? 100)}. ${chipsLabel(settledRound.outcome?.payout_chips ?? 0)} Chips Paid`
                    : blocker
                      ? blocker
                      : ticketError
                        ? ticketError
                        : !commit
                          ? 'Preparing Your Game'
                          : quotedAmount !== bet
                            ? 'Checking Your Entry'
                            : runSize
                              ? autoTarget
                                ? `${promise ? `${promise} ` : ''}Auto Play Runs ${runSize} Rounds At ${compactChips(bet)} Diamonds Each, Cashing Out At ${multiplierLabel(autoTarget)} Every Time, And Stops On Its Own If A Round Is Refused. Tap Run To Change It.`
                                : 'Auto Play Needs An Auto Cash Out: Tap Auto To Set One, Or It Cannot Cash Out For You.'
                              : `${promise ? `${promise} ` : ''}Up To ${multiplierLabel(capCents)} On This Bet. ${budget.award ? 'Your Wheel Award Is Ready.' : 'Choose Your Entry And Start.'} Auto Cash Out Is Optional.`}
              {autoRun && !open ? ` Auto Play ${autoRun.done} Of ${autoRun.total}.` : ''}
            </span>
            {settledRound?.status === 'cashed' ? (
              <span className="sc-copy sc-ink--silver">
                Would Have Crashed At {multiplierLabel(settledRound.outcome?.crash_cents ?? 100)}.
                {settledRound.outcome && settledRound.outcome.crash_cents > settledRound.cap_cents
                  ? ` This Round Would Have Booked At Its ${multiplierLabel(settledRound.cap_cents)} Limit First.`
                  : ''}{' '}
                {settledRound.fairness.server_seed && settledRound.outcome ? (
                  <SealedPrize
                    serverSeed={settledRound.fairness.server_seed}
                    clientSeed={settledRound.fairness.client_seed}
                    nonce={settledRound.fairness.nonce}
                    betChips={settledRound.bet_chips}
                    multiplierCents={Math.min(
                      settledRound.cap_cents,
                      settledRound.outcome.crash_cents
                    )}
                    roundingStep={Math.min(
                      settledRound.cap_cents,
                      settledRound.outcome.crash_cents
                    )}
                  />
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
      </GameConsole>

      <div>
        <GamePanel eyebrow="Your Game" title="How To Play" foot="foot">
          <p className="sc-copy">
            Cash Out Before The Crash To Collect Your Chip Prize. Your Confirmed Result Shows The
            Chips Paid. Your Round Limit Is Shown Before You Start. An Auto Cash Out Target Is Saved
            With The Round And Remains Active If You Disconnect.
          </p>
        </GamePanel>
      </div>

      <GamePanel
        eyebrow="Provably Fair"
        title="Check Any Round"
        plates={{
          secondary: {
            label: 'New Seed',
            onClick: () => setClientSeed(randomClientSeed()),
            disabled: open,
          },
          primary: {
            label: verifying ? 'Checking' : 'Verify Round',
            ink: 'white',
            onClick: () => settledRound && handleVerify(settledRound),
            disabled: verifying || !settledRound?.fairness.server_seed,
          },
        }}
      >
        <p className="sc-copy">
          Before You Bet, The Server Commits To A Secret Seed By Showing You Its SHA-256 Hash. The
          Round Reveals The Seed Once It Is Settled. Verify Round Checks The Saved Outcome. Nothing
          About The Crash Point Changes After The Bet Is Placed.
        </p>
        <label className={styles.seedField}>
          <span className="sc-label sc-ink--blue">Your Client Seed</span>
          <input
            className={styles.seedInput}
            value={clientSeed}
            maxLength={MAX_CLIENT_SEED}
            onChange={(e) => setClientSeed(e.target.value)}
            disabled={open}
            spellCheck={false}
          />
        </label>
        <div className={styles.seedField}>
          <span className="sc-label sc-ink--blue">Next Round Commitment</span>
          <code className={styles.mono}>{commit?.hash || 'Taking A Fresh Commitment'}</code>
        </div>
        {settledRound && settledRound.fairness.server_seed ? (
          <div className={`${styles.rows} ${styles.rowsCompact}`}>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Server Seed</span>
              <code className={styles.mono}>{settledRound.fairness.server_seed}</code>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Its Hash</span>
              <code className={styles.mono}>{settledRound.fairness.server_seed_hash}</code>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Client Seed</span>
              <code className={styles.mono}>{settledRound.fairness.client_seed}</code>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Nonce</span>
              <span className={`${styles.rowValue} sc-ink--silver`}>
                {settledRound.fairness.nonce}
              </span>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Roll</span>
              <code className={styles.mono}>
                {(settledRound.fairness.roll ?? 0).toLocaleString()} Of 281,474,976,710,656
              </code>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Crash Point</span>
              <span className={`${styles.rowValue} sc-ink--red`}>
                {multiplierLabel(settledRound.fairness.crash_cents ?? 100)}
              </span>
            </div>
            {verdict ? (
              <p
                className={`sc-copy sc-copy--center ${verdict.fair ? 'sc-ink--green' : 'sc-ink--red'}`}
              >
                {verdict.fair
                  ? 'Verified: The Hash, The Roll And The Crash Point All Match'
                  : `Mismatch: Hash ${verdict.hashMatches ? 'Ok' : 'Differs'}, Roll ${verdict.rollMatches ? 'Ok' : 'Differs'}, Crash Point ${verdict.crashMatches ? 'Ok' : 'Differs'}`}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="sc-copy sc-copy--center sc-ink--muted">
            Finish A Round And The Revealed Seed Will Appear Here For You To Check.
          </p>
        )}
      </GamePanel>

      <FloorFeed
        wins={floor?.wins ?? []}
        game="crash"
        eyebrow="The Floor"
        title="Recent Wins"
        limit={8}
      />

      <GamePanel eyebrow="Your Rounds" title="History" foot="foot">
        {history.length === 0 ? (
          <p className="sc-copy sc-copy--center sc-ink--muted">No Rounds Yet.</p>
        ) : (
          <div className={`${styles.rows} ${styles.rowsCompact}`}>
            {history.map((h) => (
              <div key={h.round_id} className={styles.row}>
                <span
                  className={`${styles.rowLabel} ${h.status === 'cashed' ? 'sc-ink--silver' : 'sc-ink--muted'}`}
                >
                  {h.status === 'cashed'
                    ? `Cashed ${multiplierLabel(h.outcome?.cashout_cents ?? 100)} On ${chipsLabel(h.bet_chips)} Chips`
                    : `Crashed ${multiplierLabel(h.outcome?.crash_cents ?? 100)} On ${chipsLabel(h.bet_chips)} Chips`}
                  <span className={`${styles.rowMeta} sc-ink--muted`}>
                    {new Date(h.created_at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </span>
                <span
                  className={`${styles.rowValue} ${h.status === 'cashed' ? 'sc-ink--gold' : 'sc-ink--red'}`}
                >
                  {`${chipsLabel(h.outcome?.payout_chips ?? 0)} Chips`}
                </span>
              </div>
            ))}
          </div>
        )}
      </GamePanel>

      {!user ? <p className="sc-copy sc-copy--center sc-ink--muted">Sign In To Play.</p> : null}
      {settledRound?.outcome &&
        revealedRoundId === settledRound.round_id &&
        !uncertain &&
        !starting &&
        !cashing && (
          <BonusCompletion
            key={settledRound.round_id}
            clubId={routeClubId ?? ''}
            chips={settledRound.outcome.payout_chips}
            detail={`The Flight Crashed At ${multiplierLabel(settledRound.outcome.crash_cents)}.`}
          />
        )}
    </div>
  );
}
