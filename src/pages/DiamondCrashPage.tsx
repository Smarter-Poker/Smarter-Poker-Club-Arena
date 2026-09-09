/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND CRASH - the player's page
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
 * Every user-facing string is Title Case, every message goes through the
 * Toast layer (CLAUDE.md 5.7). No emoji, no em dashes. The material is the
 * approved #SmarterCasinoRealism chassis (components/diamond-games).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMeasuredWidth } from '../components/diamond-games/useMeasuredWidth';
import { useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import CrashCurve, { type CrashPhase } from '../components/crash/CrashCurve';
import DiamondGamesHeader, {
  chipsText,
  dollarsText,
} from '../components/diamond-games/DiamondGamesHeader';
import {
  CasinoBay,
  CasinoBays,
  CasinoButton,
  CasinoChips,
  CasinoFrame,
  CasinoNote,
  CasinoReadout,
  CasinoWell,
} from '../components/diamond-games/CasinoChassis';
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
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import styles from '../components/diamond-games/gameDetails.module.css';

const MAX_CLIENT_SEED = 64;
const POLL_MS = 320;
const TARGETS = [101, 150, 200, 300, 500, 1000, 2000, 5000, 10000, 100000] as const;

function centsFromText(text: string): number | null {
  const v = Number(text.replace(/x/i, '').trim());
  if (!Number.isFinite(v) || v < 1.01) return null;
  return Math.round(v * 100);
}

export default function DiamondCrashPage() {
  const { clubId: routeClubId } = useParams();
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
  const [autoOn, setAutoOn] = useState(true);
  const [autoText, setAutoText] = useState('2.00');
  const [round, setRound] = useState<CrashRound | null>(null);
  const [phase, setPhase] = useState<CrashPhase>('idle');
  const [startedAtLocal, setStartedAtLocal] = useState<number | null>(null);
  const [liveCents, setLiveCents] = useState(100);
  const [starting, setStarting] = useState(false);
  const [cashing, setCashing] = useState(false);
  const [history, setHistory] = useState<CrashRound[]>([]);
  const [verdict, setVerdict] = useState<CrashFairnessVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [tab, setTab] = useState<'odds' | 'fair' | 'history'>('odds');
  const [waitSeconds, setWaitSeconds] = useState(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const roundRef = useRef<CrashRound | null>(null);
  roundRef.current = round;
  const [wellRef, wellWidth] = useMeasuredWidth<HTMLDivElement>(320);

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
        triggerHaptic('success');
        toast.success(
          `Cashed Out At ${multiplierLabel(settled.outcome?.cashout_cents ?? 100)} For ${chipsText(settled.outcome?.payout_chips ?? 0)} Chips`
        );
      } else {
        triggerHaptic('light');
      }
      setClientSeed(randomClientSeed());
      if (clubUuid) {
        void loadState(clubUuid).catch((err) => reportError(err, 'DiamondCrashPage.reload'));
        void loadHistory(clubUuid);
      }
      void freshCommit();
    },
    [stopPolling, toast, clubUuid, loadState, loadHistory, freshCommit]
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
  const betOption = useMemo(
    () => state?.bets.find((b) => b.bet_diamonds === bet) ?? state?.bets[0],
    [state, bet]
  );
  const rate = cfg?.diamonds_per_chip ?? 100;
  const betChips = betOption?.bet_chips ?? bet / rate;
  const capCents = betOption?.cap_cents ?? cfg?.max_multiplier_cents ?? 100000;
  const growthK = cfg?.growth_k ?? 0.12;
  const autoCents = autoOn ? centsFromText(autoText) : null;
  const autoTooHigh = autoOn && autoCents !== null && autoCents > capCents;
  const autoInvalid = autoOn && autoCents === null;

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
    if (autoInvalid) return 'Auto Cash Out Must Be At Least 1.01x';
    if (autoTooHigh)
      return `Auto Cash Out Must Be At Most ${multiplierLabel(capCents)} On This Bet`;
    return null;
  }, [state, player, cfg, bet, betOption, autoInvalid, autoTooHigh, capCents]);

  const open = phase === 'open';
  const canStart = Boolean(
    clubUuid && commit && !open && !starting && !blocker && waitSeconds <= 0
  );

  const handleStart = useCallback(async () => {
    if (!clubUuid || !commit || busyRef.current || open) return;
    busyRef.current = true;
    setStarting(true);
    setVerdict(null);
    triggerHaptic('medium');
    try {
      const seed = clientSeed.trim().slice(0, MAX_CLIENT_SEED) || randomClientSeed();
      const result = await DiamondGamesService.crashStart(
        clubUuid,
        commit.id,
        seed,
        bet,
        autoCents
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
    autoCents,
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

  const chartWidth = Math.max(240, Math.min(440, wellWidth - 8));
  const settledRound = round && round.status !== 'open' ? round : null;
  const finalCents = settledRound
    ? settledRound.status === 'cashed'
      ? (settledRound.outcome?.cashout_cents ?? 100)
      : (settledRound.outcome?.crash_cents ?? 100)
    : null;
  const readoutTone = phase === 'crashed' ? 'red' : phase === 'cashed' ? 'green' : 'chrome';
  const readoutLabel =
    phase === 'crashed'
      ? 'Crashed At'
      : phase === 'cashed'
        ? 'Cashed Out At'
        : phase === 'open'
          ? 'Climbing'
          : 'Ready';
  const readoutValue =
    phase === 'idle'
      ? '1.00x'
      : multiplierLabel(phase === 'open' ? liveCents : (finalCents ?? 100));
  const liveWorth = open && round ? (round.bet_chips * liveCents) / 100 : 0;
  const startLabel = starting
    ? 'Starting'
    : waitSeconds > 0
      ? `Ready In ${waitSeconds}s`
      : `Bet ${bet.toLocaleString()} Diamonds`;

  return (
    <div className={styles.page}>
      <DiamondGamesHeader
        eyebrow="Diamond Games"
        title="Diamond Crash"
        diamonds={player?.diamonds ?? 0}
        spendable={player?.spendable ?? 0}
        memberChips={player?.member_chips ?? null}
        purchasedOnly={Boolean(cfg?.purchased_only)}
        backTo={`/clubs/${routeClubId}/diamond-games`}
      />

      <CasinoFrame
        eyebrow="Cash Out Before It Crashes"
        title={`Up To ${multiplierLabel(capCents)}`}
      >
        <CasinoWell lamps>
          <div ref={wellRef}>
            <CrashCurve
              phase={phase}
              growthK={round?.growth_k ?? growthK}
              capCents={round?.cap_cents ?? capCents}
              startedAtLocalMs={startedAtLocal}
              finalCents={finalCents}
              cashoutCents={settledRound?.outcome?.cashout_cents ?? null}
              autoCashoutCents={open ? (round?.auto_cashout_cents ?? null) : autoCents}
              width={chartWidth}
              height={Math.round(chartWidth * 0.62)}
              onTick={setLiveCents}
            />
          </div>
        </CasinoWell>

        <div className={styles.result} role="status">
          <CasinoReadout label={readoutLabel} value={readoutValue} tone={readoutTone} />
          <span className={styles.resultSub}>
            {open
              ? `Worth ${chipsText(liveWorth)} Chips Right Now`
              : settledRound
                ? settledRound.status === 'cashed'
                  ? `${chipsText(settledRound.outcome?.payout_chips ?? 0)} Chips Paid, Worth ${dollarsText(settledRound.outcome?.payout_chips ?? 0)}${settledRound.outcome?.settled_by === 'time' ? ' (Settled By Your Auto Cash Out)' : ''}`
                  : `The Round Crashed At ${multiplierLabel(settledRound.outcome?.crash_cents ?? 100)}. Nothing Paid`
                : 'Pick A Bet, Set An Auto Cash Out If You Like, And Start The Round'}
          </span>
        </div>

        {open ? (
          <div className={styles.controls}>
            <CasinoButton
              tone="green"
              wide
              onClick={handleCashOut}
              disabled={cashing}
              sub={`${chipsText(liveWorth)} Chips`}
            >
              {cashing ? 'Cashing Out' : `Cash Out ${multiplierLabel(liveCents)}`}
            </CasinoButton>
            <CasinoBays columns={3}>
              <CasinoBay
                label="Bet"
                value={`${chipsText(round?.bet_chips ?? 0)}`}
                sub="Chips"
                small
              />
              <CasinoBay
                label="Auto"
                value={
                  round?.auto_cashout_cents ? multiplierLabel(round.auto_cashout_cents) : 'Off'
                }
                sub={
                  round?.auto_cashout_cents
                    ? `${crashSecondsToReach(round.growth_k, round.auto_cashout_cents).toFixed(1)}s`
                    : 'Manual'
                }
                tone="gold"
                small
              />
              <CasinoBay
                label="Max"
                value={multiplierLabel(round?.cap_cents ?? capCents)}
                sub="This Round"
                small
              />
            </CasinoBays>
          </div>
        ) : (
          <div className={styles.controls}>
            <div className={styles.pickers}>
              <span className={styles.pickerLabel}>Bet</span>
              <CasinoBays columns={2}>
                {state.bets.map((b) => (
                  <CasinoBay
                    key={b.bet_diamonds}
                    label={`${chipsText(b.bet_chips).replace(/\.00$/, '')} ${b.bet_chips === 1 ? 'Chip' : 'Chips'}`}
                    value={b.bet_diamonds.toLocaleString()}
                    sub={b.playable ? `Up To ${multiplierLabel(b.cap_cents)}` : 'Bank Too Low'}
                    selected={bet === b.bet_diamonds}
                    locked={!b.playable}
                    onClick={() => b.playable && setBet(b.bet_diamonds)}
                    disabled={!b.playable}
                    ariaLabel={`Bet ${b.bet_diamonds} Diamonds`}
                  />
                ))}
              </CasinoBays>
              <span className={styles.pickerLabel}>Auto Cash Out</span>
              <div className={styles.autoRow}>
                <div className={styles.stepper}>
                  <button
                    type="button"
                    className={styles.stepperButton}
                    onClick={() =>
                      setAutoText(((centsFromText(autoText) ?? 200) / 100 - 0.1).toFixed(2))
                    }
                    disabled={!autoOn || (centsFromText(autoText) ?? 200) <= 101}
                    aria-label="Lower Auto Cash Out"
                  >
                    -
                  </button>
                  <input
                    className={styles.stepperInput}
                    value={autoText}
                    inputMode="decimal"
                    onChange={(e) => setAutoText(e.target.value)}
                    disabled={!autoOn}
                    aria-label="Auto Cash Out Multiplier"
                  />
                  <button
                    type="button"
                    className={styles.stepperButton}
                    onClick={() =>
                      setAutoText(((centsFromText(autoText) ?? 200) / 100 + 0.1).toFixed(2))
                    }
                    disabled={!autoOn}
                    aria-label="Raise Auto Cash Out"
                  >
                    +
                  </button>
                </div>
                <label className={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={autoOn}
                    onChange={(e) => setAutoOn(e.target.checked)}
                  />
                  <span>{autoOn ? 'On' : 'Off'}</span>
                </label>
              </div>
              <CasinoChips
                label="Auto Cash Out Presets"
                value={autoOn ? (autoCents ?? 0) : 0}
                onChange={(v) => {
                  setAutoOn(true);
                  setAutoText((Number(v) / 100).toFixed(2));
                }}
                items={TARGETS.filter((t) => t <= capCents && t !== 101).map((t) => ({
                  value: t,
                  label: multiplierLabel(t),
                  sub: `${(80 / (t / 100)).toFixed(t >= 10000 ? 2 : 0)}%`,
                }))}
              />
            </div>

            <CasinoButton
              onClick={handleStart}
              disabled={!canStart}
              wide
              sub={
                waitSeconds <= 0 && !starting ? `${dollarsText(betChips)} Of Diamonds` : undefined
              }
            >
              {startLabel}
            </CasinoButton>
            {blocker ? <CasinoNote warn>{blocker}</CasinoNote> : null}
          </div>
        )}

        <CasinoBays columns={3} className={styles.facts}>
          <CasinoBay label="Return" value="80%" sub="Any Target" small />
          <CasinoBay label="Instant" value="20.8%" sub="Crash At 1.00x" small />
          <CasinoBay
            label="Today"
            value={`${(player?.rounds_today ?? 0).toLocaleString()}`}
            sub={`Of ${(cfg?.max_rounds_per_player_per_day ?? 0).toLocaleString()}`}
            small
          />
        </CasinoBays>
      </CasinoFrame>

      <div className={styles.tabs}>
        <CasinoChips
          label="Crash Details"
          value={tab}
          onChange={(v) => setTab(v as 'odds' | 'fair' | 'history')}
          items={[
            { value: 'odds', label: 'Odds' },
            { value: 'fair', label: 'Fairness' },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>

      {tab === 'odds' ? (
        <CasinoFrame eyebrow="How It Pays" title="The Odds" tight>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Cash Out At</th>
                  <th className={styles.num}>Reach Chance</th>
                  <th className={styles.num}>Reached After</th>
                  <th className={styles.num}>This Bet Pays</th>
                </tr>
              </thead>
              <tbody>
                {TARGETS.filter((t) => t <= (cfg?.max_multiplier_cents ?? 100000)).map((t) => (
                  <tr key={t}>
                    <td>{multiplierLabel(t)}</td>
                    <td className={styles.num}>{(80 / (t / 100)).toFixed(t >= 10000 ? 3 : 1)}%</td>
                    <td className={styles.num}>{crashSecondsToReach(growthK, t).toFixed(1)}s</td>
                    <td className={styles.num}>{chipsText((betChips * t) / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CasinoNote>
            The Chance Of Reaching Any Multiplier Is 80% Divided By That Multiplier, So Every Cash
            Out Target Returns 80% Over Time. About One Round In Five Crashes At 1.00x Straight Away
            And Pays Nothing. The Largest Multiplier A Round Can Reach Is What The Pool Can Cover On
            Your Bet; It Is Shown Before You Start. Crash Never Pays Out More Than It Has Taken In.
            {state.pool && state.pool.rounds > 0 && state.pool.realized_rtp !== null
              ? ` Realised Return So Far: ${(state.pool.realized_rtp * 100).toFixed(1)}% Over ${state.pool.rounds.toLocaleString()} Rounds.`
              : ''}
          </CasinoNote>
        </CasinoFrame>
      ) : null}

      {tab === 'fair' ? (
        <CasinoFrame eyebrow="Provably Fair" title="Check Any Round" tight>
          <CasinoNote>
            Before You Bet, The Server Commits To A Secret Seed By Showing You Its SHA-256 Hash. The
            Round Reveals The Seed Once It Is Settled. The Crash Point Is Floor(80 Times 2^48
            Divided By (Roll + 1)) Cents, The Roll Being The First 48 Bits Of HMAC-SHA256(Server
            Seed, Your Seed:Nonce). Nothing About The Point Changes After The Bet Is Placed.
          </CasinoNote>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              Next Round Commitment (SHA-256 Of The Server Seed)
            </span>
            <code className={styles.mono}>{commit?.hash || 'Taking A Fresh Commitment'}</code>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Your Client Seed</span>
            <input
              className={styles.input}
              value={clientSeed}
              maxLength={MAX_CLIENT_SEED}
              onChange={(e) => setClientSeed(e.target.value)}
              disabled={open}
              spellCheck={false}
            />
          </label>
          {settledRound && settledRound.fairness.server_seed ? (
            <div className={styles.reveal}>
              <dl className={styles.dl}>
                <dt>Server Seed</dt>
                <dd className={styles.mono}>{settledRound.fairness.server_seed}</dd>
                <dt>Its Hash</dt>
                <dd className={styles.mono}>{settledRound.fairness.server_seed_hash}</dd>
                <dt>Client Seed</dt>
                <dd className={styles.mono}>{settledRound.fairness.client_seed}</dd>
                <dt>Nonce</dt>
                <dd className={styles.mono}>{settledRound.fairness.nonce}</dd>
                <dt>Roll</dt>
                <dd className={styles.mono}>
                  {(settledRound.fairness.roll ?? 0).toLocaleString()} Of 281,474,976,710,656
                </dd>
                <dt>Crash Point</dt>
                <dd className={styles.mono}>
                  {multiplierLabel(settledRound.fairness.crash_cents ?? 100)}
                </dd>
              </dl>
              <CasinoButton
                tone="secondary"
                onClick={() => handleVerify(settledRound)}
                disabled={verifying}
              >
                {verifying ? 'Checking' : 'Verify This Round'}
              </CasinoButton>
              {verdict ? (
                <CasinoNote warn={!verdict.fair}>
                  {verdict.fair
                    ? 'Verified: The Hash, The Roll And The Crash Point All Match'
                    : `Mismatch: Hash ${verdict.hashMatches ? 'Ok' : 'Differs'}, Roll ${verdict.rollMatches ? 'Ok' : 'Differs'}, Crash Point ${verdict.crashMatches ? 'Ok' : 'Differs'}`}
                </CasinoNote>
              ) : null}
            </div>
          ) : (
            <CasinoNote>
              Finish A Round And The Revealed Seed Will Appear Here For You To Check.
            </CasinoNote>
          )}
        </CasinoFrame>
      ) : null}

      {tab === 'history' ? (
        <CasinoFrame eyebrow="Your Rounds" title="History" tight>
          {history.length === 0 ? (
            <CasinoNote>No Rounds Yet.</CasinoNote>
          ) : (
            <ul className={styles.history}>
              {history.map((h) => (
                <li key={h.round_id} className={styles.historyRow}>
                  <span
                    className={`${styles.dot} ${h.status === 'cashed' ? styles.dotGreen : styles.dotRed}`}
                  />
                  <span className={styles.historyLabel}>
                    {h.status === 'cashed'
                      ? `Cashed ${multiplierLabel(h.outcome?.cashout_cents ?? 100)} On ${chipsText(h.bet_chips)} Chips`
                      : `Crashed ${multiplierLabel(h.outcome?.crash_cents ?? 100)} On ${chipsText(h.bet_chips)} Chips`}
                  </span>
                  <span className={styles.historyMeta}>
                    {new Date(h.created_at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                  <span
                    className={`${styles.historyValue} ${h.status === 'cashed' ? '' : styles.historyValueRed}`}
                  >
                    {h.status === 'cashed'
                      ? dollarsText(h.outcome?.payout_chips ?? 0)
                      : `-${dollarsText(h.bet_chips)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CasinoFrame>
      ) : null}

      {!user ? <CasinoNote>Sign In To Play.</CasinoNote> : null}
    </div>
  );
}
