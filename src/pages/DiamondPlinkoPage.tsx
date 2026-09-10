/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND PLINKO - the player's page, on the console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-08: "a Plinko version, 50x can be higher on this, but crash out
 * pays nothing, and you still need to maintain the 20% edge." Three boards
 * (Steady 20x, Bold 130x, Moonshot 1000x), each auditing to exactly 80 percent
 * on the binomial odds of sixteen rows, the centre paying nothing on all of
 * them. A drop costs whole chips of diamonds (100 diamonds = 1 chip).
 *
 * WHAT THIS PAGE IS. The board, the bet, the multiplier every slot pays ON
 * THIS BET (the pool caps what it can promise; a trimmed slot prints in gold
 * with the board's own figure beside it in the odds), the fairness check and
 * the player's history. Nothing is decided here: the ball falls along the
 * sixteen bits fn_plinko_drop rolled and lands in the slot the server paid.
 *
 * THE PICTURE (#ClubArenaConsole). The deck console: the board on the glass,
 * four bays (Board and Bet are controls - tap to change, the bay's ink is its
 * state), two plates. Odds, fairness and history each on their own console.
 * Nothing is drawn but the board and the line the client seed is typed on.
 *
 * AUTO DROP (2026-09-10). The steel plate sets a run (Run Off, Run 5, 10, 25,
 * 50) and the blue plate starts it (Auto Drop 5); while it runs the steel
 * plate says Stop and the blue plate counts the ball. Every
 * ball in the run is its own server round with its own sealed commit, taken
 * one after another as each lands, and the run stops on its own the moment a
 * drop is refused, the diamonds run out, the day's limit is reached, or the
 * player leaves the page. Nothing is decided any faster and nothing is
 * decided here: the runner only presses Drop.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import PlinkoBoard from '../components/plinko/PlinkoBoard';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { DeckConsole } from '../components/console/DeckConsole';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import DiamondGamesService, {
  type GameState,
  type PlinkoDrop,
  type PlinkoTable,
} from '../services/DiamondGamesService';
import { randomClientSeed } from '../utils/wheelFairness';
import {
  PLINKO_SLOT_WEIGHTS,
  PLINKO_WEIGHT_TOTAL,
  multiplierLabel,
  verifyPlinkoDrop,
  type PlinkoFairnessVerdict,
} from '../utils/diamondGamesFairness';
import { compactChips } from '../utils/format';
import { autoRunVerdict, cycleRunSize, type AutoRun } from '../utils/autoRun';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import { soundService } from '../services/SoundService';
import FloorFeed from '../components/games/FloorFeed';
import { useGameFloor } from '../hooks/useGameFloor';
import styles from './diamondGames.module.css';

const MAX_CLIENT_SEED = 64;
/** The pause between a landing and the next ball of a run, so the slot can be read. */
const AUTO_PAUSE_MS = 700;

function odds(weight: number): string {
  const oneIn = PLINKO_WEIGHT_TOTAL / weight;
  return oneIn >= 100 ? `1 In ${Math.round(oneIn).toLocaleString()}` : `1 In ${oneIn.toFixed(1)}`;
}

/** Chips as the player reads them: whole figures compact, a fractional prize exact (it IS the prize). */
function chipsLabel(v: number): string {
  return Number.isInteger(v) ? compactChips(v) : v.toFixed(2);
}

export default function DiamondPlinkoPage() {
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
  const [tableVersion, setTableVersion] = useState<number>(2);
  const [bet, setBet] = useState<number>(100);
  const [dropping, setDropping] = useState(false);
  const [pending, setPending] = useState<PlinkoDrop | null>(null);
  const [lastResult, setLastResult] = useState<PlinkoDrop | null>(null);
  const [restingSlot, setRestingSlot] = useState<number | null>(null);
  const [dropKey, setDropKey] = useState(0);
  const [history, setHistory] = useState<PlinkoDrop[]>([]);
  const [verdict, setVerdict] = useState<PlinkoFairnessVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [autoSize, setAutoSize] = useState<number>(0);
  /** A run in progress: how many balls it is, how many have landed. */
  const [autoRun, setAutoRun] = useState<AutoRun | null>(null);
  const autoRunRef = useRef<AutoRun | null>(null);
  autoRunRef.current = autoRun;
  const busyRef = useRef(false);
  const [stageRef, stageWidth] = useMeasuredWidth<HTMLDivElement>(300);
  const { floor, refresh: refreshFloor } = useGameFloor(clubUuid, 20);

  const loadState = useCallback(
    async (uuid: string) => {
      const next = await DiamondGamesService.getState(uuid, 'plinko');
      if (!live()) return next;
      setState(next);
      setWaitSeconds(next.player?.seconds_until_next ?? 0);
      return next;
    },
    [live]
  );

  const freshCommit = useCallback(async () => {
    const c = await DiamondGamesService.commit('plinko');
    if (!live()) return;
    setCommit(c.ok ? { id: c.commit_id, hash: c.server_seed_hash } : null);
  }, [live]);

  const loadHistory = useCallback(
    async (uuid: string) => {
      try {
        const rows = await DiamondGamesService.plinkoHistory(uuid, 25);
        if (live()) setHistory(rows);
      } catch (err) {
        reportError(err, 'DiamondPlinkoPage.history');
      }
    },
    [live]
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
        if (next.tables.length && !next.tables.some((t) => t.version === tableVersion)) {
          setTableVersion(next.tables[0].version);
        }
        if (next.bets.length && !next.bets.some((b) => b.bet_diamonds === bet)) {
          setBet(next.bets[0].bet_diamonds);
        }
        if (next.available) await freshCommit();
        void loadHistory(uuid);
      } catch (err) {
        reportError(err, 'DiamondPlinkoPage.load');
        if (!cancelled && live()) setLoadError('Plinko Could Not Be Loaded');
      } finally {
        if (!cancelled && live()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeClubId, live, loadState, freshCommit, loadHistory]);

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const t = setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [waitSeconds]);

  const cfg = state?.config;
  const player = state?.player;
  const tables = useMemo(() => state?.tables ?? [], [state]);
  const bets = useMemo(() => state?.bets ?? [], [state]);
  const table: PlinkoTable | undefined = useMemo(
    () => tables.find((t) => t.version === tableVersion) ?? tables[0],
    [tables, tableVersion]
  );
  const betOption = useMemo(() => bets.find((b) => b.bet_diamonds === bet) ?? bets[0], [bets, bet]);
  const rate = cfg?.diamonds_per_chip ?? 100;
  const betChips = betOption?.bet_chips ?? bet / rate;

  /** The multiplier each slot pays on THIS bet: the board trimmed to the pool's cap. */
  const effective = useMemo(() => {
    if (!table) return [];
    const cap = betOption
      ? Math.min(betOption.cap_cents, table.max_multiplier_cents)
      : table.max_multiplier_cents;
    return table.multipliers_cents.map((m) => Math.min(m, cap));
  }, [table, betOption]);
  const anyTrimmed = useMemo(
    () => Boolean(table && effective.some((m, i) => m < (table.multipliers_cents[i] ?? 0))),
    [table, effective]
  );

  const blocker = useMemo<string | null>(() => {
    if (!state) return null;
    if (!state.available)
      return state.reason === 'not_configured' ? 'Plinko Is Not Open Here Yet' : 'Plinko Is Paused';
    if (state.frozen) return 'The Platform Is In Its Maintenance Break';
    if (player && !player.is_member) return 'Join The Club To Play';
    if (player && cfg && player.rounds_today >= cfg.max_rounds_per_player_per_day)
      return 'You Have Reached Today’s Limit';
    if (betOption && !betOption.playable)
      return 'The Club Cannot Cover A Win At That Bet Right Now';
    if (player && player.spendable < bet) {
      return cfg?.purchased_only && player.diamonds >= bet
        ? 'Plinko Takes Purchased Diamonds Only'
        : 'Not Enough Diamonds For That Bet';
    }
    return null;
  }, [state, player, cfg, bet, betOption]);

  const canDrop = Boolean(clubUuid && commit && table && !dropping && !blocker && waitSeconds <= 0);
  const running = autoRun !== null;

  const cycleTable = useCallback(() => {
    if (dropping || running || tables.length < 2) return;
    const i = tables.findIndex((t) => t.version === (table?.version ?? -1));
    setTableVersion(tables[(i + 1) % tables.length].version);
    triggerHaptic('light');
  }, [dropping, running, tables, table]);

  const cycleBet = useCallback(() => {
    if (dropping || running || bets.length < 2) return;
    const i = bets.findIndex((b) => b.bet_diamonds === bet);
    setBet(bets[(i + 1) % bets.length].bet_diamonds);
    triggerHaptic('light');
  }, [dropping, running, bets, bet]);

  const cycleAuto = useCallback(() => {
    if (dropping || running) return;
    setAutoSize(cycleRunSize);
    triggerHaptic('light');
  }, [dropping, running]);

  /** The run ends: on the last ball, on Stop, or on the first refusal. */
  const endAuto = useCallback(
    (why: string | null) => {
      if (!autoRunRef.current) return;
      setAutoRun(null);
      if (why) toast.info(why);
    },
    [toast]
  );

  const handleDrop = useCallback(async () => {
    if (!clubUuid || !commit || !table || busyRef.current || dropping) return;
    busyRef.current = true;
    setVerdict(null);
    setLastResult(null);
    /* The bet leaving. The board takes it from here: sixteen pegs, then the
       slot's own voice on the landing. */
    soundService.playChips();
    triggerHaptic('medium');
    try {
      const seed = clientSeed.trim().slice(0, MAX_CLIENT_SEED) || randomClientSeed();
      const result = await DiamondGamesService.plinkoDrop(
        clubUuid,
        commit.id,
        seed,
        table.version,
        bet
      );
      if (!live()) return;
      if (!result.ok) {
        toast.error(result.error || 'The Drop Was Refused');
        endAuto(autoRunRef.current ? 'Auto Drop Stopped' : null);
        await freshCommit();
        if (clubUuid) void loadState(clubUuid).catch(() => undefined);
        return;
      }
      setPending(result);
      setRestingSlot(null);
      setDropping(true);
      setDropKey((k) => k + 1);
    } catch (err) {
      reportError(err, 'DiamondPlinkoPage.drop');
      if (live()) toast.error('The Drop Did Not Go Through. Nothing Was Charged');
      endAuto(autoRunRef.current ? 'Auto Drop Stopped' : null);
      await freshCommit();
    } finally {
      busyRef.current = false;
    }
  }, [
    clubUuid,
    commit,
    table,
    dropping,
    clientSeed,
    bet,
    live,
    toast,
    freshCommit,
    loadState,
    endAuto,
  ]);

  const handleLanded = useCallback(() => {
    if (!pending) return;
    const result = pending;
    setPending(null);
    setDropping(false);
    setLastResult(result);
    setRestingSlot(result.outcome.slot);
    if (result.outcome.payout_chips > 0) {
      triggerHaptic('success');
      toast.success(
        `${multiplierLabel(result.outcome.multiplier_cents)} Pays ${chipsLabel(result.outcome.payout_chips)} Chips`
      );
    } else {
      triggerHaptic('light');
    }
    setClientSeed(randomClientSeed());
    setAutoRun((r) => (r ? { ...r, done: r.done + 1 } : r));
    if (clubUuid) {
      void loadState(clubUuid).catch((err) => reportError(err, 'DiamondPlinkoPage.reload'));
      void loadHistory(clubUuid);
      void refreshFloor();
    }
    /* The commit this ball used is spent. Clear it before asking for the next,
       so nothing (the runner included) can press Drop on a dead ticket. */
    setCommit(null);
    void freshCommit();
  }, [pending, toast, clubUuid, loadState, loadHistory, freshCommit, refreshFloor]);

  const startAuto = useCallback(() => {
    if (!autoSize || running || dropping) return;
    triggerHaptic('medium');
    setAutoRun({ total: autoSize, done: 0 });
  }, [autoSize, running, dropping]);

  const stopAuto = useCallback(() => endAuto('Auto Drop Stopped'), [endAuto]);

  /* The runner. It presses Drop when the page would let a thumb press it:
     a fresh commit in hand, the pause between drops served, nothing blocking.
     It does not wait for anything the page does not wait for, and it stops
     the moment the page would refuse. */
  useEffect(() => {
    const verdict = autoRunVerdict(
      autoRun,
      { busy: dropping, blocker, ready: canDrop },
      AUTO_PAUSE_MS
    );
    if (verdict.kind === 'wait') return;
    if (verdict.kind === 'finished') {
      setAutoRun(null);
      toast.success(`Auto Drop Finished: ${autoRun?.total ?? 0} Drops`);
      return;
    }
    if (verdict.kind === 'blocked') {
      setAutoRun(null);
      toast.info(`Auto Drop Stopped: ${verdict.why}`);
      return;
    }
    const t = setTimeout(() => void handleDrop(), verdict.delayMs);
    return () => clearTimeout(t);
  }, [autoRun, dropping, blocker, canDrop, handleDrop, toast]);

  const handleVerify = useCallback(
    async (result: PlinkoDrop) => {
      setVerifying(true);
      try {
        const v = await verifyPlinkoDrop({
          serverSeed: result.fairness.server_seed,
          serverSeedHash: result.fairness.server_seed_hash,
          clientSeed: result.fairness.client_seed,
          nonce: result.fairness.nonce,
          hmacHex: result.fairness.hmac_hex,
          slot: result.outcome.slot,
          pathBits: result.outcome.path_bits,
        });
        if (!live()) return;
        setVerdict(v);
        if (v.fair) toast.success('This Drop Verifies');
        else toast.warning('This Drop Did Not Verify. Please Report It');
      } catch (err) {
        reportError(err, 'DiamondPlinkoPage.verify');
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
          message={loadError || 'Plinko Could Not Be Loaded'}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const path = pending?.outcome.path ?? null;
  const boardWidth = Math.max(220, Math.min(420, stageWidth - 4));
  const dropLabel = autoRun
    ? `Ball ${Math.min(autoRun.done + 1, autoRun.total)} Of ${autoRun.total}`
    : dropping
      ? 'Dropping'
      : waitSeconds > 0
        ? `Ready In ${waitSeconds}s`
        : autoSize
          ? `Auto Drop ${autoSize}`
          : `Drop ${bet.toLocaleString()}`;
  const autoLabel = running ? 'Stop' : autoSize ? `Run ${autoSize}` : 'Run Off';
  const pill = state.frozen
    ? 'Break'
    : state.available
      ? 'Open'
      : state.reason === 'not_configured'
        ? 'Closed'
        : 'Paused';
  const pillInk = state.frozen ? 'gold' : state.available ? 'green' : 'red';

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
        title="Diamond Plinko"
        titleId="diamond-plinko-title"
        pill={pill}
        pillInk={pillInk}
        aria-labelledby="diamond-plinko-title"
        bays={[
          {
            label: 'Board',
            value: table?.name ?? '',
            ink: 'white',
            onPress: cycleTable,
            pressLabel: 'Change Board',
            disabled: dropping || running || tables.length < 2,
          },
          {
            label: 'Bet',
            value: compactChips(bet),
            ink: betOption && !betOption.playable ? 'red' : 'white',
            onPress: cycleBet,
            pressLabel: 'Change Bet',
            disabled: dropping || running || bets.length < 2,
          },
          { label: 'Diamonds', value: compactChips(player?.diamonds ?? 0), ink: 'blue' },
          { label: 'Chips', value: compactChips(player?.member_chips ?? 0), ink: 'silver' },
        ]}
        secondary={
          running
            ? { label: autoLabel, ink: 'red', onClick: stopAuto }
            : {
                label: autoLabel,
                ink: autoSize ? 'gold' : 'silver',
                onClick: cycleAuto,
                disabled: dropping,
              }
        }
        primary={
          running
            ? { label: dropLabel, ink: 'gold', disabled: true }
            : autoSize
              ? { label: dropLabel, ink: 'gold', onClick: startAuto, disabled: !canDrop }
              : { label: dropLabel, ink: 'white', onClick: handleDrop, disabled: !canDrop }
        }
      >
        <div className={styles.stage} ref={stageRef}>
          <div className={styles.board}>
            <PlinkoBoard
              multipliersCents={effective}
              tableMultipliersCents={table?.multipliers_cents}
              path={path}
              dropKey={dropKey}
              restingSlot={restingSlot}
              onLanded={handleLanded}
              width={boardWidth}
            />
          </div>
          {lastResult && !dropping ? (
            <div className={styles.readout} role="status">
              <span className="sc-label sc-ink--blue">
                {lastResult.outcome.payout_chips > 0 ? 'You Won' : 'No Payout'}
              </span>
              <span
                className={`${styles.readoutValue} ${lastResult.outcome.payout_chips > 0 ? 'sc-ink--gold' : 'sc-ink--muted'}`}
              >
                {lastResult.outcome.payout_chips > 0
                  ? `${chipsLabel(lastResult.outcome.payout_chips)} Chips`
                  : multiplierLabel(lastResult.outcome.multiplier_cents)}
              </span>
              <span className={`sc-copy ${styles.readoutSub}`}>
                {lastResult.outcome.payout_chips > 0
                  ? `${multiplierLabel(lastResult.outcome.multiplier_cents)} On ${chipsLabel(lastResult.bet_chips)} ${lastResult.bet_chips === 1 ? 'Chip' : 'Chips'}`
                  : 'The Centre Pays Nothing. Drop Again'}
                {lastResult.outcome.capped ? ' (Trimmed To What The Pool Could Pay)' : ''}
                {autoRun ? ` Auto Drop ${autoRun.done} Of ${autoRun.total}.` : ''}
              </span>
            </div>
          ) : (
            <p className={`sc-copy sc-copy--center ${styles.readoutSub}`}>
              {blocker
                ? blocker
                : autoSize && !running
                  ? `Auto Drop Sends ${autoSize} Balls One After Another At ${compactChips(bet)} Diamonds Each, And Stops On Its Own If A Drop Is Refused. Tap Run To Change It.`
                  : anyTrimmed
                    ? 'Gold Slots Are Trimmed To The Biggest Win The Pool Can Cover On This Bet Right Now. Tap Board Or Bet To Change Them.'
                    : `${table?.name ?? ''} Pays Up To ${table ? multiplierLabel(table.max_multiplier_cents) : ''}. Tap Board Or Bet To Change Them. The Centre Pays Nothing.`}
            </p>
          )}
        </div>
      </DeckConsole>

      <div>
        <SpadeConsole eyebrow="The Board" title={table ? `${table.name} Odds` : 'Odds'} foot="foot">
          {table ? (
            <div className={styles.rows}>
              <div className={`${styles.grid4} ${styles.grid4Head}`}>
                <span className="sc-label sc-ink--blue">Slot</span>
                <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Pays</span>
                <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Chance</span>
                <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Bet Pays</span>
              </div>
              {table.multipliers_cents.slice(0, 9).map((m, k) => {
                const mirror = 16 - k;
                const weight = PLINKO_SLOT_WEIGHTS[k] * (k === 8 ? 1 : 2);
                const eff = effective[k] ?? m;
                return (
                  <div key={k} className={styles.grid4}>
                    <span
                      className={`${styles.cell} ${m === 0 ? 'sc-ink--muted' : 'sc-ink--silver'}`}
                    >
                      {k === 8 ? 'Centre' : `${k + 1} And ${mirror + 1}`}
                      <span className={`${styles.rowMeta} sc-ink--muted`}>{odds(weight)}</span>
                    </span>
                    <span
                      className={`${styles.cell} ${styles.cellRight} ${eff < m ? 'sc-ink--gold' : 'sc-ink--silver'}`}
                    >
                      {multiplierLabel(eff)}
                      {eff < m ? (
                        <span className={`${styles.rowMeta} sc-ink--muted`}>
                          Board {multiplierLabel(m)}
                        </span>
                      ) : null}
                    </span>
                    <span className={`${styles.cell} ${styles.cellRight} sc-ink--silver`}>
                      {((weight / PLINKO_WEIGHT_TOTAL) * 100).toFixed(weight < 1000 ? 3 : 1)}%
                    </span>
                    <span className={`${styles.cell} ${styles.cellRight} sc-ink--gold`}>
                      {eff > 0 ? chipsLabel((betChips * eff) / 100) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
          <p className="sc-copy">
            Sixteen Rows, Seventeen Slots. The Ball Goes Left Or Right At Every Peg With Equal Odds,
            So The Edges Are Rare And The Centre Is Common. The Board Returns 80% Of Everything It
            Takes In Over Time And Never Pays Out More Than It Has Taken In.
            {state.pool && state.pool.rounds > 0 && state.pool.realized_rtp !== null
              ? ` Realised Return So Far: ${(state.pool.realized_rtp * 100).toFixed(0)}% Over ${compactChips(state.pool.rounds)} Drops.`
              : ''}
          </p>
        </SpadeConsole>
      </div>

      <SpadeConsole
        eyebrow="Provably Fair"
        title="Check Any Drop"
        plates={{
          secondary: {
            label: 'New Seed',
            onClick: () => setClientSeed(randomClientSeed()),
            disabled: dropping,
          },
          primary: {
            label: verifying ? 'Checking' : 'Verify Drop',
            ink: 'white',
            onClick: () => lastResult && handleVerify(lastResult),
            disabled: verifying || !lastResult,
          },
        }}
      >
        <p className="sc-copy">
          Before You Drop, The Server Commits To A Secret Seed By Showing You Its SHA-256 Hash. Your
          Drop Reveals The Seed. The Ball’s Path Is The First Sixteen Bits Of HMAC-SHA256(Server
          Seed, Your Seed:Nonce), One Bit Per Row, Right When The Bit Is One. The Slot Is The Number
          Of Rights.
        </p>
        <label className={styles.seedField}>
          <span className="sc-label sc-ink--blue">Your Client Seed</span>
          <input
            className={styles.seedInput}
            value={clientSeed}
            maxLength={MAX_CLIENT_SEED}
            onChange={(e) => setClientSeed(e.target.value)}
            disabled={dropping}
            spellCheck={false}
          />
        </label>
        <div className={styles.seedField}>
          <span className="sc-label sc-ink--blue">Next Drop Commitment</span>
          <code className={styles.mono}>{commit?.hash || 'Taking A Fresh Commitment'}</code>
        </div>
        {lastResult ? (
          <div className={`${styles.rows} ${styles.rowsCompact}`}>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Server Seed</span>
              <code className={styles.mono}>{lastResult.fairness.server_seed}</code>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Its Hash</span>
              <code className={styles.mono}>{lastResult.fairness.server_seed_hash}</code>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Client Seed</span>
              <code className={styles.mono}>{lastResult.fairness.client_seed}</code>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Nonce</span>
              <span className={`${styles.rowValue} sc-ink--silver`}>
                {lastResult.fairness.nonce}
              </span>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>HMAC</span>
              <code className={styles.mono}>{lastResult.fairness.hmac_hex}</code>
            </div>
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>Path</span>
              <code className={styles.mono}>
                {lastResult.outcome.path.map((b) => (b ? 'R' : 'L')).join(' ')} (Slot{' '}
                {lastResult.outcome.slot + 1})
              </code>
            </div>
            {verdict ? (
              <p
                className={`sc-copy sc-copy--center ${verdict.fair ? 'sc-ink--green' : 'sc-ink--red'}`}
              >
                {verdict.fair
                  ? 'Verified: The Hash, The HMAC And The Path All Match'
                  : `Mismatch: Hash ${verdict.hashMatches ? 'Ok' : 'Differs'}, HMAC ${verdict.hmacMatches ? 'Ok' : 'Differs'}, Path ${verdict.pathMatches ? 'Ok' : 'Differs'}`}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="sc-copy sc-copy--center sc-ink--muted">
            Drop Once And The Revealed Seed Will Appear Here For You To Check.
          </p>
        )}
      </SpadeConsole>

      <FloorFeed
        wins={floor?.wins ?? []}
        game="plinko"
        eyebrow="The Floor"
        title="Recent Wins"
        limit={8}
      />

      <SpadeConsole eyebrow="Your Drops" title="History" foot="foot">
        {history.length === 0 ? (
          <p className="sc-copy sc-copy--center sc-ink--muted">No Drops Yet.</p>
        ) : (
          <div className={`${styles.rows} ${styles.rowsCompact}`}>
            {history.map((h) => (
              <div key={h.drop_id} className={styles.row}>
                <span className={`${styles.rowLabel} sc-ink--silver`}>
                  {multiplierLabel(h.outcome.multiplier_cents)} On {chipsLabel(h.bet_chips)} Chips
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
                  className={`${styles.rowValue} ${h.outcome.payout_chips > 0 ? 'sc-ink--gold' : 'sc-ink--muted'}`}
                >
                  {h.outcome.payout_chips > 0 ? `${chipsLabel(h.outcome.payout_chips)} Chips` : '0'}
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
