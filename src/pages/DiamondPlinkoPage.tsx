/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND PLINKO - the player's page
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-08: "a Plinko version, 50x can be higher on this, but crash out
 * pays nothing, and you still need to maintain the 20% edge." Three tables
 * (Steady 20x, Bold 130x, Moonshot 1000x), each auditing to exactly 80 percent
 * on the binomial odds of a 16-row board, the centre paying nothing on all of
 * them. A drop costs whole chips of diamonds (100 diamonds = 1 chip).
 *
 * WHAT THIS PAGE IS. The board, the bet and table pickers, the multiplier every
 * slot pays ON THIS BET (the pool caps what it can promise; a trimmed slot is
 * shown in gold with the table's own figure beside it in the odds), the
 * fairness panel and the player's history. Nothing is decided here: the ball
 * falls along the sixteen bits fn_plinko_drop rolled and lands in the slot the
 * server paid.
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
import PlinkoBoard from '../components/plinko/PlinkoBoard';
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
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import styles from '../components/diamond-games/gameDetails.module.css';

const MAX_CLIENT_SEED = 64;

function odds(weight: number): string {
  const oneIn = PLINKO_WEIGHT_TOTAL / weight;
  return oneIn >= 100 ? `1 In ${Math.round(oneIn).toLocaleString()}` : `1 In ${oneIn.toFixed(1)}`;
}

function outcomeHeadline(d: PlinkoDrop): string {
  if (d.outcome.payout_chips <= 0) return 'The Ball Fell Through';
  return `${multiplierLabel(d.outcome.multiplier_cents)} Pays ${chipsText(d.outcome.payout_chips)} Chips`;
}

export default function DiamondPlinkoPage() {
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
  const [tab, setTab] = useState<'odds' | 'fair' | 'history'>('odds');
  const [waitSeconds, setWaitSeconds] = useState(0);
  const busyRef = useRef(false);
  const [wellRef, wellWidth] = useMeasuredWidth<HTMLDivElement>(320);

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
  const table: PlinkoTable | undefined = useMemo(
    () => state?.tables.find((t) => t.version === tableVersion) ?? state?.tables[0],
    [state, tableVersion]
  );
  const betOption = useMemo(
    () => state?.bets.find((b) => b.bet_diamonds === bet) ?? state?.bets[0],
    [state, bet]
  );
  const rate = cfg?.diamonds_per_chip ?? 100;
  const betChips = betOption?.bet_chips ?? bet / rate;

  /** The multiplier each slot pays on THIS bet: the table trimmed to the pool's cap. */
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
      return 'The Bank Cannot Cover A Win At That Bet Right Now';
    if (player && player.spendable < bet) {
      return cfg?.purchased_only && player.diamonds >= bet
        ? 'Plinko Takes Purchased Diamonds Only'
        : 'Not Enough Diamonds For That Bet';
    }
    return null;
  }, [state, player, cfg, bet, betOption]);

  const canDrop = Boolean(clubUuid && commit && table && !dropping && !blocker && waitSeconds <= 0);

  const handleDrop = useCallback(async () => {
    if (!clubUuid || !commit || !table || busyRef.current || dropping) return;
    busyRef.current = true;
    setVerdict(null);
    setLastResult(null);
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
      await freshCommit();
    } finally {
      busyRef.current = false;
    }
  }, [clubUuid, commit, table, dropping, clientSeed, bet, live, toast, freshCommit, loadState]);

  const handleLanded = useCallback(() => {
    if (!pending) return;
    const result = pending;
    setPending(null);
    setDropping(false);
    setLastResult(result);
    setRestingSlot(result.outcome.slot);
    if (result.outcome.payout_chips > 0) {
      triggerHaptic('success');
      toast.success(outcomeHeadline(result));
    } else {
      triggerHaptic('light');
    }
    setClientSeed(randomClientSeed());
    if (clubUuid) {
      void loadState(clubUuid).catch((err) => reportError(err, 'DiamondPlinkoPage.reload'));
      void loadHistory(clubUuid);
    }
    void freshCommit();
  }, [pending, toast, clubUuid, loadState, loadHistory, freshCommit]);

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
  const boardWidth = Math.max(240, Math.min(440, wellWidth - 8));
  const dropLabel = dropping
    ? 'Dropping'
    : waitSeconds > 0
      ? `Ready In ${waitSeconds}s`
      : `Drop For ${bet.toLocaleString()} Diamonds`;

  return (
    <div className={styles.page}>
      <DiamondGamesHeader
        eyebrow="Diamond Games"
        title="Diamond Plinko"
        diamonds={player?.diamonds ?? 0}
        spendable={player?.spendable ?? 0}
        memberChips={player?.member_chips ?? null}
        purchasedOnly={Boolean(cfg?.purchased_only)}
        backTo={`/clubs/${routeClubId}/diamond-games`}
      />

      <CasinoFrame
        eyebrow={table ? `${table.name} Board` : 'Board'}
        title={table ? `Up To ${multiplierLabel(table.max_multiplier_cents)}` : ''}
      >
        <CasinoWell lamps>
          <div ref={wellRef}>
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
        </CasinoWell>

        {lastResult && !dropping ? (
          <div className={styles.result} role="status">
            <CasinoReadout
              label={lastResult.outcome.payout_chips > 0 ? 'You Won' : 'No Payout'}
              value={
                lastResult.outcome.payout_chips > 0
                  ? `${chipsText(lastResult.outcome.payout_chips)} Chips`
                  : multiplierLabel(lastResult.outcome.multiplier_cents)
              }
              tone={lastResult.outcome.payout_chips > 0 ? 'gold' : 'red'}
            />
            <span className={styles.resultSub}>
              {lastResult.outcome.payout_chips > 0
                ? `${multiplierLabel(lastResult.outcome.multiplier_cents)} On ${chipsText(lastResult.bet_chips)} Chips, Worth ${dollarsText(lastResult.outcome.payout_chips)}`
                : 'The Centre Pays Nothing. Drop Again'}
              {lastResult.outcome.capped ? ' (Trimmed To What The Pool Could Pay)' : ''}
            </span>
          </div>
        ) : null}

        <div className={styles.pickers}>
          <span className={styles.pickerLabel}>Table</span>
          <CasinoChips
            label="Plinko Table"
            value={table?.version ?? 0}
            onChange={(v) => !dropping && setTableVersion(Number(v))}
            items={state.tables.map((t) => ({
              value: t.version,
              label: t.name,
              sub: `Up To ${multiplierLabel(t.max_multiplier_cents)}`,
              disabled: dropping,
            }))}
          />
          <span className={styles.pickerLabel}>Bet</span>
          <CasinoBays columns={2}>
            {state.bets.map((b) => (
              <CasinoBay
                key={b.bet_diamonds}
                label={`${chipsText(b.bet_chips).replace(/\.00$/, '')} ${b.bet_chips === 1 ? 'Chip' : 'Chips'}`}
                value={b.bet_diamonds.toLocaleString()}
                sub={b.playable ? 'Diamonds' : 'Bank Too Low'}
                selected={bet === b.bet_diamonds}
                locked={!b.playable}
                onClick={() => !dropping && b.playable && setBet(b.bet_diamonds)}
                disabled={dropping || !b.playable}
                ariaLabel={`Bet ${b.bet_diamonds} Diamonds`}
              />
            ))}
          </CasinoBays>
        </div>

        <CasinoButton
          onClick={handleDrop}
          disabled={!canDrop}
          wide
          sub={!dropping && waitSeconds <= 0 ? `${dollarsText(betChips)} Of Diamonds` : undefined}
        >
          {dropLabel}
        </CasinoButton>

        {blocker ? <CasinoNote warn>{blocker}</CasinoNote> : null}
        {anyTrimmed && !blocker ? (
          <CasinoNote warn>
            Gold Slots Are Trimmed To The Biggest Win The Pool Can Cover On This Bet Right Now. They
            Grow As The Pool Grows.
          </CasinoNote>
        ) : null}

        <CasinoBays columns={3} className={styles.facts}>
          <CasinoBay label="Return" value="80%" sub="Every Table" small />
          <CasinoBay
            label="Pays"
            value={table ? `${(table.hit_rate * 100).toFixed(0)}%` : ''}
            sub="Of Balls"
            small
          />
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
          label="Plinko Details"
          value={tab}
          onChange={(v) => setTab(v as 'odds' | 'fair' | 'history')}
          items={[
            { value: 'odds', label: 'Odds' },
            { value: 'fair', label: 'Fairness' },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>

      {tab === 'odds' && table ? (
        <CasinoFrame eyebrow="The Board" title={`${table.name} Odds`} tight>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Slot</th>
                  <th className={styles.num}>Pays</th>
                  <th className={styles.num}>Chance</th>
                  <th className={styles.num}>Bet Pays</th>
                </tr>
              </thead>
              <tbody>
                {table.multipliers_cents.slice(0, 9).map((m, k) => {
                  const mirror = 16 - k;
                  const weight = PLINKO_SLOT_WEIGHTS[k] * (k === 8 ? 1 : 2);
                  const eff = effective[k] ?? m;
                  return (
                    <tr key={k} className={m === 0 ? styles.rowDead : undefined}>
                      <td>{k === 8 ? 'Centre' : `${k + 1} And ${mirror + 1}`}</td>
                      <td className={styles.num}>
                        {multiplierLabel(m)}
                        {eff < m ? (
                          <span className={styles.trim}> ({multiplierLabel(eff)} Now)</span>
                        ) : null}
                      </td>
                      <td className={styles.num}>
                        {((weight / PLINKO_WEIGHT_TOTAL) * 100).toFixed(weight < 1000 ? 3 : 1)}%
                        <span className={styles.subCell}>{odds(weight)}</span>
                      </td>
                      <td className={styles.num}>
                        {eff > 0 ? chipsText((betChips * eff) / 100) : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <CasinoNote>
            Sixteen Rows, Seventeen Slots. The Ball Goes Left Or Right At Every Peg With Equal Odds,
            So The Edges Are Rare And The Centre Is Common. The Board Returns 80% Of Everything It
            Takes In Over Time And Never Pays Out More Than It Has Taken In.
            {state.pool && state.pool.rounds > 0 && state.pool.realized_rtp !== null
              ? ` Realised Return So Far: ${(state.pool.realized_rtp * 100).toFixed(1)}% Over ${state.pool.rounds.toLocaleString()} Drops.`
              : ''}
          </CasinoNote>
        </CasinoFrame>
      ) : null}

      {tab === 'fair' ? (
        <CasinoFrame eyebrow="Provably Fair" title="Check Any Drop" tight>
          <CasinoNote>
            Before You Drop, The Server Commits To A Secret Seed By Showing You Its SHA-256 Hash.
            Your Drop Reveals The Seed. The Ball’s Path Is The First Sixteen Bits Of
            HMAC-SHA256(Server Seed, Your Seed:Nonce), One Bit Per Row, Right When The Bit Is One.
            The Slot Is The Number Of Rights.
          </CasinoNote>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              Next Drop Commitment (SHA-256 Of The Server Seed)
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
              disabled={dropping}
              spellCheck={false}
            />
          </label>
          {lastResult ? (
            <div className={styles.reveal}>
              <dl className={styles.dl}>
                <dt>Server Seed</dt>
                <dd className={styles.mono}>{lastResult.fairness.server_seed}</dd>
                <dt>Its Hash</dt>
                <dd className={styles.mono}>{lastResult.fairness.server_seed_hash}</dd>
                <dt>Client Seed</dt>
                <dd className={styles.mono}>{lastResult.fairness.client_seed}</dd>
                <dt>Nonce</dt>
                <dd className={styles.mono}>{lastResult.fairness.nonce}</dd>
                <dt>HMAC</dt>
                <dd className={styles.mono}>{lastResult.fairness.hmac_hex}</dd>
                <dt>Path</dt>
                <dd className={styles.mono}>
                  {lastResult.outcome.path.map((b) => (b ? 'R' : 'L')).join(' ')} (Slot{' '}
                  {lastResult.outcome.slot + 1})
                </dd>
              </dl>
              <CasinoButton
                tone="secondary"
                onClick={() => handleVerify(lastResult)}
                disabled={verifying}
              >
                {verifying ? 'Checking' : 'Verify This Drop'}
              </CasinoButton>
              {verdict ? (
                <CasinoNote warn={!verdict.fair}>
                  {verdict.fair
                    ? 'Verified: The Hash, The HMAC And The Path All Match'
                    : `Mismatch: Hash ${verdict.hashMatches ? 'Ok' : 'Differs'}, HMAC ${verdict.hmacMatches ? 'Ok' : 'Differs'}, Path ${verdict.pathMatches ? 'Ok' : 'Differs'}`}
                </CasinoNote>
              ) : null}
            </div>
          ) : (
            <CasinoNote>
              Drop Once And The Revealed Seed Will Appear Here For You To Check.
            </CasinoNote>
          )}
        </CasinoFrame>
      ) : null}

      {tab === 'history' ? (
        <CasinoFrame eyebrow="Your Drops" title="History" tight>
          {history.length === 0 ? (
            <CasinoNote>No Drops Yet.</CasinoNote>
          ) : (
            <ul className={styles.history}>
              {history.map((h) => (
                <li key={h.drop_id} className={styles.historyRow}>
                  <span
                    className={`${styles.dot} ${h.outcome.payout_chips > 0 ? styles.dotGold : styles.dotDark}`}
                  />
                  <span className={styles.historyLabel}>
                    {multiplierLabel(h.outcome.multiplier_cents)} On {chipsText(h.bet_chips)} Chips
                  </span>
                  <span className={styles.historyMeta}>
                    {new Date(h.created_at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className={styles.historyValue}>
                    {h.outcome.payout_chips > 0 ? dollarsText(h.outcome.payout_chips) : ''}
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
