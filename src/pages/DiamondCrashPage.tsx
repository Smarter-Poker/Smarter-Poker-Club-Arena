/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND CRASH - the player's page, on the console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-08: "a Crash / Aviator-style: multiplier climbs until it
 * crashes; cash out first. 50x can be higher on this, but crash out pays
 * nothing, and you still need to maintain the 20% edge." The crash point is
 * X = floor(80 * 2^48 / (r + 1)) cents on the round's 48-bit roll, so
 * P(reaching x) = 0.8 / x: every cash-out target returns 80 percent in
 * expectation, about one round in five crashes at 1.00x before anyone can
 * move, and the curve climbs as e^(0.12 t) (2x at 5.8s, 50x at 32.6s, the
 * 1000x ceiling at 57.6s).
 *
 * THE CLOCK IS THE SERVER'S. fn_crash_start seals the crash point and stamps
 * started_at; the page draws e^(k t) from that stamp (offset from the server's
 * own "now" in the same reply) and asks fn_crash_settle every few hundred
 * milliseconds what the round is. A cash-out is a server call, settled at the
 * multiplier the server's clock reads when it lands. An auto cash-out target
 * is honoured by the server the moment the curve passes it, whatever this tab
 * does afterwards, so a dropped connection cannot cost a planned exit.
 *
 * THE PICTURE (#ClubArenaConsole). The deck console: the curve on the glass,
 * four bays (Bet and Auto are controls - tap to change, the bay's ink is its
 * state), two plates. While a round is open the primary plate IS the cash-out,
 * printed in green with the live multiplier. Odds, fairness and history each
 * on their own console. Nothing is drawn but the curve and the seed line.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import CrashCurve, { type CrashPhase } from '../components/crash/CrashCurve';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { DeckConsole } from '../components/console/DeckConsole';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import DiamondGamesService, {
  type CrashRound,
  type GameState,
} from '../services/DiamondGamesService';
import { randomClientSeed } from '../utils/wheelFairness';
import {
  crashSecondsToReach,
  multiplierLabel,
  verifyCrashRound,
  type CrashFairnessVerdict,
} from '../utils/diamondGamesFairness';
import { compactChips } from '../utils/format';
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
/** The odds table's rows and the auto cash-out presets, in cents. 0 is Off. */
const TARGETS = [150, 200, 300, 500, 1000, 2000, 5000, 10000, 100000] as const;
const AUTO_PRESETS = [0, 150, 200, 300, 500, 1000, 2000, 5000] as const;

/** Chips as the player reads them: whole figures compact, a fractional prize exact (it IS the prize). */
function chipsLabel(v: number): string {
  return Number.isInteger(v) ? compactChips(v) : v.toFixed(2);
}

function reachChance(cents: number): string {
  const pct = 80 / (cents / 100);
  return `${pct.toFixed(pct < 1 ? 2 : pct < 10 ? 1 : 0)}%`;
}

export default function DiamondCrashPage() {
  const { clubId: routeClubId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMountedRef = useIsMounted();
  const live = useCallback(() => isMountedRef.current, [isMountedRef]);

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commit, setCommit] = useState<{ id: string; hash: string } | null>(null);
  const [clientSeed, setClientSeed] = useState<string>(() => randomClientSeed());
  const [bet, setBet] = useState<number>(100);
  const [autoCents, setAutoCents] = useState<number>(200);
  const [round, setRound] = useState<CrashRound | null>(null);
  const [phase, setPhase] = useState<CrashPhase>('idle');
  const [startedAtLocal, setStartedAtLocal] = useState<number | null>(null);
  const [liveCents, setLiveCents] = useState(100);
  const [starting, setStarting] = useState(false);
  const [cashing, setCashing] = useState(false);
  const [history, setHistory] = useState<CrashRound[]>([]);
  const [verdict, setVerdict] = useState<CrashFairnessVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const roundRef = useRef<CrashRound | null>(null);
  roundRef.current = round;
  const oddsRef = useRef<HTMLDivElement | null>(null);
  const [stageRef, stageWidth] = useMeasuredWidth<HTMLDivElement>(300);
  const { floor, refresh: refreshFloor } = useGameFloor(clubUuid, 20);

  const loadState = useCallback(
    async (uuid: string) => {
      const next = await DiamondGamesService.getState(uuid, 'crash');
      if (!live()) return next;
      setState(next);
      setWaitSeconds(next.player?.seconds_until_next ?? 0);
      return next;
    },
    [live]
  );

  const freshCommit = useCallback(async () => {
    const c = await DiamondGamesService.commit('crash');
    if (!live()) return;
    setCommit(c.ok ? { id: c.commit_id, hash: c.server_seed_hash } : null);
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
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** A settled round: stop the clock, show the outcome, refresh everything. */
  const finish = useCallback(
    (settled: CrashRound) => {
      stopPolling();
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
      if (clubUuid) {
        void loadState(clubUuid).catch((err) => reportError(err, 'DiamondCrashPage.reload'));
        void loadHistory(clubUuid);
        void refreshFloor();
      }
      void freshCommit();
    },
    [stopPolling, toast, clubUuid, loadState, loadHistory, freshCommit, refreshFloor]
  );

  /** Adopt an open round (fresh or resumed) and start asking the server about it. */
  const adopt = useCallback(
    (open: CrashRound) => {
      setRound(open);
      setPhase('open');
      setStartedAtLocal(performance.now() - open.elapsed_ms);
      setLiveCents(open.multiplier_now_cents ?? 100);
      stopPolling();
      const tick = async () => {
        const current = roundRef.current;
        if (!current || current.round_id !== open.round_id) return;
        try {
          const next = await DiamondGamesService.crashSettle(open.round_id, false);
          if (!live()) return;
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
        pollRef.current = setTimeout(tick, POLL_MS);
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
        const next = await loadState(uuid);
        if (cancelled || !live()) return;
        if (next.bets.length && !next.bets.some((b) => b.bet_diamonds === bet)) {
          setBet(next.bets[0].bet_diamonds);
        }
        if (next.available) await freshCommit();
        void loadHistory(uuid);
        if (next.open_round && next.open_round.status === 'open') adopt(next.open_round);
      } catch (err) {
        reportError(err, 'DiamondCrashPage.load');
        if (!cancelled && live()) setLoadError('Crash Could Not Be Loaded');
      } finally {
        if (!cancelled && live()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeClubId]);

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const t = setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [waitSeconds]);

  const cfg = state?.config;
  const player = state?.player;
  const bets = useMemo(() => state?.bets ?? [], [state]);
  const betOption = useMemo(() => bets.find((b) => b.bet_diamonds === bet) ?? bets[0], [bets, bet]);
  const rate = cfg?.diamonds_per_chip ?? 100;
  const betChips = betOption?.bet_chips ?? bet / rate;
  const capCents = betOption?.cap_cents ?? cfg?.max_multiplier_cents ?? 100000;
  const growthK = cfg?.growth_k ?? 0.12;
  const autoPresets = useMemo(
    () => AUTO_PRESETS.filter((t) => t === 0 || t <= capCents),
    [capCents]
  );
  const autoChoice = autoCents > capCents ? 0 : autoCents;
  const autoTarget = autoChoice > 0 ? autoChoice : null;

  const blocker = useMemo<string | null>(() => {
    if (!state) return null;
    if (!state.available)
      return state.reason === 'not_configured' ? 'Crash Is Not Open Here Yet' : 'Crash Is Paused';
    if (state.frozen) return 'The Platform Is In Its Maintenance Break';
    if (player && !player.is_member) return 'Join The Club To Play';
    if (player && cfg && player.rounds_today >= cfg.max_rounds_per_player_per_day)
      return 'You Have Reached Today’s Limit';
    if (betOption && !betOption.playable)
      return 'The Bank Cannot Cover A Win At That Bet Right Now';
    if (player && player.spendable < bet) {
      return cfg?.purchased_only && player.diamonds >= bet
        ? 'Crash Takes Purchased Diamonds Only'
        : 'Not Enough Diamonds For That Bet';
    }
    return null;
  }, [state, player, cfg, bet, betOption]);

  const open = phase === 'open';
  const canStart = Boolean(
    clubUuid && commit && !open && !starting && !blocker && waitSeconds <= 0
  );

  const cycleBet = useCallback(() => {
    if (open || starting || bets.length < 2) return;
    const i = bets.findIndex((b) => b.bet_diamonds === bet);
    setBet(bets[(i + 1) % bets.length].bet_diamonds);
    triggerHaptic('light');
  }, [open, starting, bets, bet]);

  const cycleAuto = useCallback(() => {
    if (open || starting) return;
    const i = autoPresets.indexOf(autoChoice as (typeof AUTO_PRESETS)[number]);
    setAutoCents(autoPresets[(i + 1) % autoPresets.length]);
    triggerHaptic('light');
  }, [open, starting, autoPresets, autoChoice]);

  const handleStart = useCallback(async () => {
    if (!clubUuid || !commit || busyRef.current || open) return;
    busyRef.current = true;
    setStarting(true);
    setVerdict(null);
    soundService.playSpinStart();
    triggerHaptic('medium');
    try {
      const seed = clientSeed.trim().slice(0, MAX_CLIENT_SEED) || randomClientSeed();
      const result = await DiamondGamesService.crashStart(
        clubUuid,
        commit.id,
        seed,
        bet,
        autoTarget
      );
      if (!live()) return;
      if (!result.ok) {
        toast.error(result.error || 'The Round Was Refused');
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
      if (live()) toast.error('The Round Did Not Start. Nothing Was Charged');
      await freshCommit();
    } finally {
      busyRef.current = false;
      if (live()) setStarting(false);
    }
  }, [
    clubUuid,
    commit,
    open,
    clientSeed,
    bet,
    autoTarget,
    live,
    toast,
    freshCommit,
    loadState,
    finish,
    adopt,
  ]);

  const handleCashOut = useCallback(async () => {
    const current = roundRef.current;
    if (!current || phase !== 'open' || cashing) return;
    setCashing(true);
    triggerHaptic('heavy');
    try {
      const next = await DiamondGamesService.crashSettle(current.round_id, true);
      if (!live()) return;
      if (!next.ok) {
        toast.error(next.error || 'The Cash Out Was Refused');
        return;
      }
      if (next.status === 'open') {
        toast.info('The Round Is Waiting Out The Maintenance Break');
        return;
      }
      finish(next);
    } catch (err) {
      reportError(err, 'DiamondCrashPage.cashout');
      if (live()) toast.error('The Cash Out Did Not Reach The Server. Trying Again');
    } finally {
      if (live()) setCashing(false);
    }
  }, [phase, cashing, live, toast, finish]);

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
        });
        if (!live()) return;
        setVerdict(v);
        if (v.fair) toast.success('This Round Verifies');
        else toast.warning('This Round Did Not Verify. Please Report It');
      } catch (err) {
        reportError(err, 'DiamondCrashPage.verify');
        if (live()) toast.error('The Check Could Not Run In This Browser');
      } finally {
        if (live()) setVerifying(false);
      }
    },
    [live, toast]
  );

  if (loading) return <PageSkeleton />;
  if (loadError || !state) {
    return (
      <div className={styles.page}>
        <ErrorState
          message={loadError || 'Crash Could Not Be Loaded'}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const chartWidth = Math.max(220, Math.min(420, stageWidth - 4));
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
  const startLabel = starting
    ? 'Starting'
    : waitSeconds > 0
      ? `Ready In ${waitSeconds}s`
      : `Start ${bet.toLocaleString()}`;
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
    <div className={styles.page}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(`/clubs/${routeClubId}/diamond-games`)}
      >
        ‹ Diamond Games
      </button>

      <DeckConsole
        eyebrow="Diamond Games"
        title="Diamond Crash"
        titleId="diamond-crash-title"
        pill={pill}
        pillInk={pillInk}
        aria-labelledby="diamond-crash-title"
        bays={[
          {
            label: 'Bet',
            value: open && round ? compactChips(round.bet_diamonds) : compactChips(bet),
            ink: betOption && !betOption.playable ? 'red' : 'white',
            onPress: cycleBet,
            pressLabel: 'Change Bet',
            disabled: open || starting || bets.length < 2,
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
            disabled: open || starting,
          },
          { label: 'Diamonds', value: compactChips(player?.diamonds ?? 0), ink: 'blue' },
          { label: 'Chips', value: compactChips(player?.member_chips ?? 0), ink: 'silver' },
        ]}
        secondary={{
          label: 'Odds',
          onClick: () => oddsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        }}
        primary={
          open
            ? {
                label: cashing ? 'Cashing Out' : `Cash Out ${multiplierLabel(liveCents)}`,
                ink: 'green',
                onClick: handleCashOut,
                disabled: cashing,
              }
            : { label: startLabel, ink: 'white', onClick: handleStart, disabled: !canStart }
        }
      >
        <div className={styles.stage} ref={stageRef}>
          <CrashPointsStrip points={floor?.crash_points ?? []} />
          <div className={styles.board}>
            <CrashCurve
              phase={phase}
              growthK={round?.growth_k ?? growthK}
              capCents={round?.cap_cents ?? capCents}
              startedAtLocalMs={startedAtLocal}
              finalCents={finalCents}
              cashoutCents={settledRound?.outcome?.cashout_cents ?? null}
              autoCashoutCents={open ? roundAuto : autoTarget}
              width={chartWidth}
              height={Math.round(chartWidth * 0.58)}
              onTick={setLiveCents}
            />
          </div>
          <div className={styles.readout} role="status">
            <span className="sc-label sc-ink--blue">{readoutLabel}</span>
            <span className={`${styles.readoutValue} ${readoutInk}`}>{readoutValue}</span>
            <span className={`sc-copy ${styles.readoutSub}`}>
              {open
                ? `Worth ${chipsLabel(liveWorth)} Chips Right Now`
                : settledRound
                  ? settledRound.status === 'cashed'
                    ? `${chipsLabel(settledRound.outcome?.payout_chips ?? 0)} Chips Paid${settledRound.outcome?.settled_by === 'time' ? ' By Your Auto Cash Out' : ''}`
                    : `Crashed At ${multiplierLabel(settledRound.outcome?.crash_cents ?? 100)}. Nothing Paid`
                  : blocker
                    ? blocker
                    : `Up To ${multiplierLabel(capCents)} On This Bet. Tap Bet Or Auto To Change Them.`}
            </span>
          </div>
        </div>
      </DeckConsole>

      <div ref={oddsRef}>
        <SpadeConsole eyebrow="How It Pays" title="The Odds" foot="foot">
          <div className={styles.rows}>
            <div className={`${styles.grid4} ${styles.grid4Head}`}>
              <span className="sc-label sc-ink--blue">Cash Out</span>
              <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Chance</span>
              <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>After</span>
              <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Bet Pays</span>
            </div>
            {TARGETS.filter((t) => t <= (cfg?.max_multiplier_cents ?? 100000)).map((t) => (
              <div key={t} className={styles.grid4}>
                <span
                  className={`${styles.cell} ${t > capCents ? 'sc-ink--muted' : 'sc-ink--silver'}`}
                >
                  {multiplierLabel(t)}
                </span>
                <span className={`${styles.cell} ${styles.cellRight} sc-ink--silver`}>
                  {reachChance(t)}
                </span>
                <span className={`${styles.cell} ${styles.cellRight} sc-ink--silver`}>
                  {crashSecondsToReach(growthK, t).toFixed(1)}s
                </span>
                <span
                  className={`${styles.cell} ${styles.cellRight} ${t > capCents ? 'sc-ink--muted' : 'sc-ink--gold'}`}
                >
                  {t > capCents ? 'Over Cap' : chipsLabel((betChips * t) / 100)}
                </span>
              </div>
            ))}
          </div>
          <p className="sc-copy">
            The Chance Of Reaching Any Multiplier Is 80% Divided By That Multiplier, So Every Cash
            Out Target Returns 80% Over Time. About One Round In Five Crashes At 1x Straight Away
            And Pays Nothing. The Largest Multiplier A Round Can Reach Is What The Pool Can Cover On
            Your Bet; It Is Shown Before You Start. Crash Never Pays Out More Than It Has Taken In.
            {state.pool && state.pool.rounds > 0 && state.pool.realized_rtp !== null
              ? ` Realised Return So Far: ${(state.pool.realized_rtp * 100).toFixed(0)}% Over ${compactChips(state.pool.rounds)} Rounds.`
              : ''}
          </p>
        </SpadeConsole>
      </div>

      <SpadeConsole
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
          Round Reveals The Seed Once It Is Settled. The Crash Point Is Floor(80 Times 2^48 Divided
          By (Roll + 1)) Cents, The Roll Being The First 48 Bits Of HMAC-SHA256(Server Seed, Your
          Seed:Nonce). Nothing About The Point Changes After The Bet Is Placed.
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
      </SpadeConsole>

      <FloorFeed
        wins={floor?.wins ?? []}
        game="crash"
        eyebrow="The Floor"
        title="Recent Wins"
        limit={8}
      />

      <SpadeConsole eyebrow="Your Rounds" title="History" foot="foot">
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
                  {h.status === 'cashed'
                    ? `${chipsLabel(h.outcome?.payout_chips ?? 0)} Chips`
                    : '0'}
                </span>
              </div>
            ))}
          </div>
        )}
      </SpadeConsole>

      {!user ? <p className="sc-copy sc-copy--center sc-ink--muted">Sign In To Play.</p> : null}
    </div>
  );
}
