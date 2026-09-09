/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL - the player's page
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07: "I want to add a Diamond To Chip spinning wheel game to the
 * Club Arena, where players can potentially convert their diamonds into chips
 * ... costing a certain amount of diamonds per spin, and awarding prizes,
 * chips, diamonds, or nothing. House edge on this should be 20% and never pay
 * more out than we take in." Rates, same day: 1 diamond = $0.01, 1 chip = $1.00.
 *
 * WHAT THIS PAGE IS. The wheel, the odds beside it, the player's own limits,
 * the fairness panel and their spin history, all read from fn_wheel_state /
 * fn_wheel_history and moved by fn_wheel_spin. Nothing on this screen is
 * computed here except the fairness re-check, which exists precisely so the
 * browser can disagree with the server if it ever has reason to.
 *
 * WHY THE ODDS ARE ON THE SCREEN. Players lose 20 percent on average, and a
 * locked top tier looks like a rigged wheel to anyone who does not know why it
 * is grey. The odds table, the pool's realised return, the unlock figures and
 * the verify panel are the difference between a feature and a complaint.
 *
 * WHY A COMMIT BEFORE THE SPIN. fn_wheel_commit hands the player the SHA-256
 * of the server's seed before they press Spin; the spin reveals the seed and
 * the player may change the client seed at any time. HMAC(server, client:nonce)
 * is the roll, recomputable here with WebCrypto (src/utils/wheelFairness.ts).
 *
 * Every user-facing string is Title Case and every message goes through the
 * Toast layer (CLAUDE.md 5.7). No emoji, no em dashes. The material is the
 * approved #SmarterCasinoRealism chassis (Dan 2026-09-08; components/diamond-games).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import DiamondWheel from '../components/wheel/DiamondWheel';
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
import DiamondWheelService, {
  type WheelSegment,
  type WheelSpinResult,
  type WheelState,
} from '../services/DiamondWheelService';
import {
  randomClientSeed,
  verifyWheelSpin,
  type WheelFairnessVerdict,
} from '../utils/wheelFairness';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import styles from '../components/diamond-games/gameDetails.module.css';

function odds(probability: number): string {
  if (probability <= 0) return '';
  const oneIn = 1 / probability;
  return oneIn >= 100 ? `1 In ${Math.round(oneIn).toLocaleString()}` : `1 In ${oneIn.toFixed(1)}`;
}

function prizeLabel(seg: { kind: string; amount: number; label: string }): string {
  if (seg.kind === 'nothing') return 'Nothing';
  if (seg.kind === 'diamonds') return `${seg.amount.toLocaleString()} Diamonds`;
  return `${chipsText(seg.amount)} Chips`;
}

function outcomeHeadline(result: WheelSpinResult): string {
  const o = result.outcome;
  if (o.kind === 'nothing') return 'No Prize This Spin';
  if (o.kind === 'diamonds') return `You Won ${o.amount.toLocaleString()} Diamonds`;
  return `You Won ${chipsText(o.amount)} Chips`;
}

const MAX_CLIENT_SEED = 64;

export default function DiamondWheelPage() {
  const { clubId: routeClubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [state, setState] = useState<WheelState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commit, setCommit] = useState<{ id: string; hash: string } | null>(null);
  const [clientSeed, setClientSeed] = useState<string>(() => randomClientSeed());
  const [spinning, setSpinning] = useState(false);
  const [pending, setPending] = useState<WheelSpinResult | null>(null);
  const [lastResult, setLastResult] = useState<WheelSpinResult | null>(null);
  const [spinKey, setSpinKey] = useState(0);
  const [history, setHistory] = useState<WheelSpinResult[]>([]);
  const [verdict, setVerdict] = useState<WheelFairnessVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [tab, setTab] = useState<'odds' | 'fair' | 'history'>('odds');
  const [waitSeconds, setWaitSeconds] = useState(0);
  const busyRef = useRef(false);

  const live = useCallback(() => isMountedRef.current, [isMountedRef]);

  const loadState = useCallback(
    async (uuid: string) => {
      const next = await DiamondWheelService.getState(uuid);
      if (!live()) return next;
      setState(next);
      setWaitSeconds(next.player?.seconds_until_next ?? 0);
      return next;
    },
    [live]
  );

  const freshCommit = useCallback(async () => {
    const c = await DiamondWheelService.commit();
    if (!live()) return;
    if (!c.ok) {
      setCommit(null);
      return;
    }
    setCommit({ id: c.commit_id, hash: c.server_seed_hash });
  }, [live]);

  const loadHistory = useCallback(
    async (uuid: string) => {
      try {
        const rows = await DiamondWheelService.history(uuid, 25);
        if (live()) setHistory(rows);
      } catch (err) {
        reportError(err, 'DiamondWheelPage.history');
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
        if (next.available) await freshCommit();
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
  }, [routeClubId, live, loadState, freshCommit, loadHistory]);

  // The between-spins pause counts down on screen instead of surprising the
  // player with a refusal.
  useEffect(() => {
    if (waitSeconds <= 0) return;
    const t = setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [waitSeconds]);

  const segments: WheelSegment[] = state?.segments ?? [];
  const cfg = state?.config;
  const player = state?.player;
  const price = cfg?.spin_price_diamonds ?? 0;
  const priceChips = cfg?.spin_price_chips ?? 0;

  const blocker = useMemo<string | null>(() => {
    if (!state) return null;
    if (!state.available)
      return state.reason === 'not_configured'
        ? 'The Diamond Wheel Is Not Open Here Yet'
        : 'The Diamond Wheel Is Paused';
    if (state.frozen) return 'The Platform Is In Its Maintenance Break';
    if (player && !player.is_member) return 'Join The Club To Spin';
    if (player && cfg && player.spins_today >= cfg.max_spins_per_player_per_day)
      return 'You Have Reached Today’s Spin Limit';
    if (player && player.spendable < price) {
      return cfg?.purchased_only && player.diamonds >= price
        ? 'This Wheel Spins Purchased Diamonds Only'
        : 'Not Enough Diamonds For A Spin';
    }
    return null;
  }, [state, player, cfg, price]);

  const canSpin = Boolean(clubUuid && commit && !spinning && !blocker && waitSeconds <= 0);

  const handleSpin = useCallback(async () => {
    if (!clubUuid || !commit || busyRef.current || spinning) return;
    busyRef.current = true;
    setVerdict(null);
    setLastResult(null);
    triggerHaptic('medium');
    try {
      const seed = clientSeed.trim().slice(0, MAX_CLIENT_SEED) || randomClientSeed();
      const result = await DiamondWheelService.spin(clubUuid, commit.id, seed);
      if (!live()) return;
      if (!result.ok) {
        toast.error(result.error || 'The Spin Was Refused');
        // The commit may have been spent or expired; take a fresh one either way.
        await freshCommit();
        return;
      }
      setPending(result);
      setSpinKey((k) => k + 1);
      setSpinning(true);
    } catch (err) {
      reportError(err, 'DiamondWheelPage.spin');
      if (live()) toast.error('The Spin Did Not Go Through. Nothing Was Charged');
      await freshCommit();
    } finally {
      busyRef.current = false;
    }
  }, [clubUuid, commit, spinning, clientSeed, live, toast, freshCommit]);

  const handleLanded = useCallback(() => {
    if (!pending) return;
    const result = pending;
    setPending(null);
    setSpinning(false);
    setLastResult(result);
    if (result.outcome.kind === 'nothing') triggerHaptic('light');
    else triggerHaptic('success');
    if (result.outcome.kind !== 'nothing') toast.success(outcomeHeadline(result));
    setClientSeed(randomClientSeed());
    if (clubUuid) {
      void loadState(clubUuid).catch((err) => reportError(err, 'DiamondWheelPage.reload'));
      void loadHistory(clubUuid);
    }
    void freshCommit();
  }, [pending, toast, clubUuid, loadState, loadHistory, freshCommit]);

  const handleVerify = useCallback(
    async (result: WheelSpinResult) => {
      setVerifying(true);
      try {
        const eligible = segments
          .filter((s) => result.fairness.eligible_ords.includes(s.ord))
          .map((s) => ({ ord: s.ord, weight: s.weight }));
        const v = await verifyWheelSpin({
          serverSeed: result.fairness.server_seed,
          serverSeedHash: result.fairness.server_seed_hash,
          clientSeed: result.fairness.client_seed,
          nonce: result.fairness.nonce,
          roll: result.fairness.roll,
          weightTotal: result.fairness.weight_total,
          eligible,
          outcomeOrd: result.outcome.ord,
        });
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
    [segments, live, toast]
  );

  if (loading) return <PageSkeleton />;
  if (loadError || !state) {
    return (
      <div className={styles.page}>
        <ErrorState
          message={loadError || 'The Wheel Could Not Be Loaded'}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const landingOrd = pending?.outcome.ord ?? null;
  const spinLabel = spinning
    ? 'Spinning'
    : waitSeconds > 0
      ? `Ready In ${waitSeconds}s`
      : `Spin For ${price.toLocaleString()} Diamonds`;
  const wheelSize = Math.min(340, typeof window !== 'undefined' ? window.innerWidth - 72 : 340);

  return (
    <div className={styles.page}>
      <DiamondGamesHeader
        eyebrow="Diamond Games"
        title="Diamond Wheel"
        diamonds={player?.diamonds ?? 0}
        spendable={player?.spendable ?? 0}
        memberChips={player?.member_chips ?? null}
        purchasedOnly={Boolean(cfg?.purchased_only)}
        backTo={`/clubs/${routeClubId}/diamond-games`}
      />

      <CasinoFrame eyebrow="Spin The Wheel" title="Eleven Prizes">
        <CasinoWell lamps>
          <div className={styles.wheelWell}>
            <DiamondWheel
              segments={segments}
              landingOrd={landingOrd}
              spinKey={spinKey}
              spinning={spinning}
              onLanded={handleLanded}
              size={wheelSize}
            />
          </div>
        </CasinoWell>

        {lastResult && !spinning ? (
          <div className={styles.result} role="status">
            <CasinoReadout
              label={lastResult.outcome.kind === 'nothing' ? 'No Prize' : 'You Won'}
              value={
                lastResult.outcome.kind === 'nothing'
                  ? 'Nothing'
                  : lastResult.outcome.kind === 'diamonds'
                    ? `${lastResult.outcome.amount.toLocaleString()} Diamonds`
                    : `${chipsText(lastResult.outcome.amount)} Chips`
              }
              tone={lastResult.outcome.kind === 'nothing' ? 'red' : 'gold'}
            />
            <span className={styles.resultSub}>
              {lastResult.outcome.kind === 'nothing'
                ? 'Better Luck On The Next Spin'
                : `Worth ${dollarsText(lastResult.outcome.value_chips)} At Today’s Rate`}
            </span>
          </div>
        ) : null}

        <div className={styles.controls}>
          <CasinoButton
            onClick={handleSpin}
            disabled={!canSpin}
            wide
            sub={
              !spinning && waitSeconds <= 0 ? `${dollarsText(priceChips)} Of Diamonds` : undefined
            }
          >
            {spinLabel}
          </CasinoButton>
          {blocker ? <CasinoNote warn>{blocker}</CasinoNote> : null}
        </div>

        <CasinoBays columns={3} className={styles.facts}>
          <CasinoBay
            label="Return"
            value={cfg ? `${(cfg.spec_rtp * 100).toFixed(0)}%` : '80%'}
            sub="To Player"
            small
          />
          <CasinoBay
            label="Pays"
            value={cfg ? `${(cfg.hit_rate * 100).toFixed(1)}%` : ''}
            sub="Of Spins"
            small
          />
          <CasinoBay
            label="Today"
            value={`${(player?.spins_today ?? 0).toLocaleString()}`}
            sub={`Of ${(cfg?.max_spins_per_player_per_day ?? 0).toLocaleString()}`}
            small
          />
        </CasinoBays>
      </CasinoFrame>

      <div className={styles.tabs}>
        <CasinoChips
          label="Wheel Details"
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
        <CasinoFrame eyebrow="The Prizes" title="Odds" tight>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Prize</th>
                  <th className={styles.num}>Odds</th>
                  <th className={styles.num}>Chance</th>
                  <th className={styles.num}>Worth</th>
                </tr>
              </thead>
              <tbody>
                {[...segments]
                  .sort((a, b) => b.value_chips - a.value_chips)
                  .map((seg) => (
                    <tr key={seg.ord} className={seg.locked ? styles.rowDead : undefined}>
                      <td>
                        <span
                          className={`${styles.dot} ${seg.kind === 'chips' ? styles.dotGold : seg.kind === 'diamonds' ? styles.dotCyan : styles.dotDark}`}
                        />{' '}
                        {prizeLabel(seg)}
                        {seg.locked ? (
                          <span className={styles.trim}>
                            {seg.kind === 'diamonds'
                              ? ` Locked Until The Pool Holds ${(seg.unlocks_at ?? 0).toLocaleString()} More Diamonds`
                              : ' Locked Until The Pool Can Cover It'}
                          </span>
                        ) : null}
                      </td>
                      <td className={styles.num}>{odds(seg.probability)}</td>
                      <td className={styles.num}>
                        {(seg.probability * 100).toFixed(seg.probability < 0.01 ? 2 : 1)}%
                      </td>
                      <td className={styles.num}>
                        {seg.kind === 'nothing' ? '' : dollarsText(seg.value_chips)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <CasinoNote>
            Every Spin Is {price.toLocaleString()} Diamonds ({dollarsText(priceChips)}). The Wheel
            Returns 80% Of Everything It Takes In Over Time And Never Pays Out More Than It Has
            Taken In. A Locked Prize Is One The Pool Cannot Cover Yet; It Unlocks As The Pool Grows.
            {state.pool && state.pool.spins > 0 && state.pool.realized_rtp !== null
              ? ` Realised Return So Far: ${(state.pool.realized_rtp * 100).toFixed(1)}% Over ${state.pool.spins.toLocaleString()} Spins.`
              : ''}
          </CasinoNote>
        </CasinoFrame>
      ) : null}

      {tab === 'fair' ? (
        <CasinoFrame eyebrow="Provably Fair" title="Check Any Spin" tight>
          <CasinoNote>
            Before You Spin, The Server Commits To A Secret Seed By Showing You Its SHA-256 Hash.
            Your Spin Reveals The Seed. The Result Is HMAC-SHA256(Server Seed, Your Seed:Nonce),
            Read As A Number From 0 To 2^48 And Mapped Onto The Prizes That Were Available. You Can
            Check Every Spin Right Here.
          </CasinoNote>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              Next Spin Commitment (SHA-256 Of The Server Seed)
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
              disabled={spinning}
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
                <dt>Roll</dt>
                <dd className={styles.mono}>
                  {lastResult.fairness.roll.toLocaleString()} Of 281,474,976,710,656
                </dd>
                <dt>Outcome</dt>
                <dd>{lastResult.outcome.label}</dd>
              </dl>
              <CasinoButton
                tone="secondary"
                onClick={() => handleVerify(lastResult)}
                disabled={verifying}
              >
                {verifying ? 'Checking' : 'Verify This Spin'}
              </CasinoButton>
              {verdict ? (
                <CasinoNote warn={!verdict.fair}>
                  {verdict.fair
                    ? 'Verified: The Hash, The Roll And The Outcome All Match'
                    : `Mismatch: Hash ${verdict.hashMatches ? 'Ok' : 'Differs'}, Roll ${verdict.rollMatches ? 'Ok' : 'Differs'}, Outcome ${verdict.outcomeMatches ? 'Ok' : 'Differs'}`}
                </CasinoNote>
              ) : null}
            </div>
          ) : (
            <CasinoNote>
              Spin Once And The Revealed Seed Will Appear Here For You To Check.
            </CasinoNote>
          )}
        </CasinoFrame>
      ) : null}

      {tab === 'history' ? (
        <CasinoFrame eyebrow="Your Spins" title="History" tight>
          {history.length === 0 ? (
            <CasinoNote>No Spins Yet.</CasinoNote>
          ) : (
            <ul className={styles.history}>
              {history.map((h) => (
                <li key={h.spin_id} className={styles.historyRow}>
                  <span
                    className={`${styles.dot} ${h.outcome.kind === 'chips' ? styles.dotGold : h.outcome.kind === 'diamonds' ? styles.dotCyan : styles.dotDark}`}
                  />
                  <span className={styles.historyLabel}>{prizeLabel(h.outcome)}</span>
                  <span className={styles.historyMeta}>
                    {new Date(h.created_at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className={styles.historyValue}>
                    {h.outcome.kind === 'nothing' ? '' : dollarsText(h.outcome.value_chips)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CasinoFrame>
      ) : null}

      {!user ? <CasinoNote>Sign In To Spin.</CasinoNote> : null}
    </div>
  );
}
