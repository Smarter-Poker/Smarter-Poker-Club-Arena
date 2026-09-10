/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL - the player's page, on the console
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
 * THE PICTURE (#ClubArenaConsole, Dan 2026-09-09). Every frame, bay, plate
 * and pill is the approved spade master (components/console): the game sits
 * on the deck console (head, the wheel on the glass, four bays, two plates),
 * the odds, the fairness check and the history each on their own console.
 * Nothing is drawn but the wheel itself and the line the client seed is
 * typed on. Title Case, no em dashes, no emoji, no :hover.
 *
 * THE FREE SPIN (2026-09-09). One spin a day on the house, per player per
 * host, from its own five-prize table that pays diamonds only: a free spin
 * takes nothing in, and the games never pay out more than they take in. When
 * fn_wheel_free_state says it is available the page opens in free mode - the
 * pill, the Spin bay and the primary plate say so in gold, the wheel and the
 * odds show the free table - and the SAME commit and the same verifier serve
 * it. When it lands, the paid wheel returns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import DiamondWheel from '../components/wheel/DiamondWheel';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { DeckConsole } from '../components/console/DeckConsole';
import { useMeasuredWidth } from '../hooks/useMeasuredWidth';
import DiamondWheelService, {
  mergeSpinHistory,
  type WheelFreeState,
  type WheelSegment,
  type WheelSpinResult,
  type WheelState,
} from '../services/DiamondWheelService';
import {
  randomClientSeed,
  verifyWheelSpin,
  type WheelFairnessVerdict,
} from '../utils/wheelFairness';
import { compactChips } from '../utils/format';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { triggerHaptic } from '../services/HapticService';
import { soundService } from '../services/SoundService';
import FloorFeed from '../components/games/FloorFeed';
import { useGameFloor } from '../hooks/useGameFloor';
import styles from './diamondGames.module.css';

function odds(probability: number): string {
  if (probability <= 0) return '';
  const oneIn = 1 / probability;
  return oneIn >= 100 ? `1 In ${Math.round(oneIn).toLocaleString()}` : `1 In ${oneIn.toFixed(1)}`;
}

/** A prize as the player reads it. Chips under one stay exact: they ARE the prize. */
function prizeLabel(seg: { kind: string; amount: number; label: string }): string {
  if (seg.kind === 'nothing') return 'Nothing';
  if (seg.kind === 'diamonds') return `${seg.amount.toLocaleString()} Diamonds`;
  const chips = Number.isInteger(seg.amount) ? compactChips(seg.amount) : seg.amount.toFixed(2);
  return `${chips} ${seg.amount === 1 ? 'Chip' : 'Chips'}`;
}

function outcomeHeadline(result: WheelSpinResult): string {
  const o = result.outcome;
  if (o.kind === 'nothing') return 'No Prize This Spin';
  return result.free ? `Free Spin: You Won ${prizeLabel(o)}` : `You Won ${prizeLabel(o)}`;
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

export default function DiamondWheelPage() {
  const { clubId: routeClubId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMountedRef = useIsMounted();
  const live = useCallback(() => isMountedRef.current, [isMountedRef]);

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [state, setState] = useState<WheelState | null>(null);
  const [free, setFree] = useState<WheelFreeState | null>(null);
  /** Today's free spin is on offer: the plates, the odds and the next spin are free. */
  const [freeMode, setFreeMode] = useState(false);
  /* The face on the rim. It lags the offer by one spin on purpose: after the
     free spin lands, the prize it landed on stays under the pointer until
     the next spin starts, and only then does the paid table come round. */
  const [face, setFace] = useState<'paid' | 'free'>('paid');
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
  const [waitSeconds, setWaitSeconds] = useState(0);
  const busyRef = useRef(false);
  const oddsRef = useRef<HTMLDivElement | null>(null);
  const [stageRef, stageWidth] = useMeasuredWidth<HTMLDivElement>(300);
  const { floor, refresh: refreshFloor } = useGameFloor(clubUuid, 20);

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

  const loadFree = useCallback(
    async (uuid: string) => {
      try {
        const next = await DiamondWheelService.freeState(uuid);
        if (live()) setFree(next);
        return next;
      } catch (err) {
        reportError(err, 'DiamondWheelPage.free');
        return null;
      }
    },
    [live]
  );

  const freshCommit = useCallback(async () => {
    const c = await DiamondWheelService.commit();
    if (!live()) return;
    setCommit(c.ok ? { id: c.commit_id, hash: c.server_seed_hash } : null);
  }, [live]);

  const loadHistory = useCallback(
    async (uuid: string) => {
      try {
        const [paid, onTheHouse] = await Promise.all([
          DiamondWheelService.history(uuid, 25),
          DiamondWheelService.freeHistory(uuid, 25).catch((err) => {
            reportError(err, 'DiamondWheelPage.freeHistory');
            return [] as WheelSpinResult[];
          }),
        ]);
        if (live()) setHistory(mergeSpinHistory(paid, onTheHouse));
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
        const [next, onTheHouse] = await Promise.all([loadState(uuid), loadFree(uuid)]);
        if (cancelled || !live()) return;
        if (next.available && onTheHouse?.available) {
          setFreeMode(true);
          setFace('free');
        }
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
  }, [routeClubId, live, loadState, loadFree, freshCommit, loadHistory]);

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const t = setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [waitSeconds]);

  const segments: WheelSegment[] = state?.segments ?? [];
  const freeSegments: WheelSegment[] = free?.segments ?? [];
  /* The odds follow the offer; the rim follows the last spin (see `face`). */
  const table = freeMode ? freeSegments : segments;
  const rim = face === 'free' ? freeSegments : segments;
  const cfg = state?.config;
  const player = state?.player;
  const price = cfg?.spin_price_diamonds ?? 0;

  const blocker = useMemo<string | null>(() => {
    if (!state) return null;
    if (!state.available)
      return state.reason === 'not_configured'
        ? 'The Diamond Wheel Is Not Open Here Yet'
        : 'The Diamond Wheel Is Paused';
    if (state.frozen) return 'The Platform Is In Its Maintenance Break';
    if (player && !player.is_member) return 'Join The Club To Spin';
    if (freeMode) return null; // the house pays: no price, no limit, no purchased-only rule
    if (player && cfg && player.spins_today >= cfg.max_spins_per_player_per_day)
      return 'You Have Reached Today’s Spin Limit';
    if (player && player.spendable < price) {
      return cfg?.purchased_only && player.diamonds >= price
        ? 'This Wheel Spins Purchased Diamonds Only'
        : 'Not Enough Diamonds For A Spin';
    }
    return null;
  }, [state, player, cfg, price, freeMode]);

  // The pause between paid spins is the paid wheel's; a spin on the house does not wait for it.
  const canSpin = Boolean(
    clubUuid && commit && !spinning && !blocker && (freeMode || waitSeconds <= 0)
  );

  const handleSpin = useCallback(async () => {
    if (!clubUuid || !commit || busyRef.current || spinning) return;
    busyRef.current = true;
    setVerdict(null);
    setLastResult(null);
    triggerHaptic('medium');
    try {
      const seed = clientSeed.trim().slice(0, MAX_CLIENT_SEED) || randomClientSeed();
      const result = freeMode
        ? await DiamondWheelService.freeSpin(clubUuid, commit.id, seed)
        : await DiamondWheelService.spin(clubUuid, commit.id, seed);
      if (!live()) return;
      if (!result.ok) {
        toast.error(result.error || 'The Spin Was Refused');
        if (freeMode) {
          /* The server said why (used, the pot is spent, the switch is off);
             the free state carries the same reason, so read it again and let
             the paid wheel back if the free spin is no longer on offer. */
          const next = await loadFree(clubUuid);
          if (live() && next && !next.available) {
            setFreeMode(false);
            setFace('paid');
          }
        }
        await freshCommit();
        return;
      }
      if (!result.free) setFace('paid'); // a paid spin turns on the paid table
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
  }, [clubUuid, commit, spinning, clientSeed, live, toast, freshCommit, freeMode, loadFree]);

  const handleLanded = useCallback(() => {
    if (!pending) return;
    const result = pending;
    setPending(null);
    setSpinning(false);
    setLastResult(result);
    if (result.outcome.kind === 'nothing') triggerHaptic('light');
    else {
      /* The prize decides the voice: a big win is a big win, the rest of the
         paying segments get the ordinary one. The wheel itself has already
         ticked and stopped; this is the prize speaking, not the wheel. */
      if (result.outcome.value_chips >= 5) soundService.playBigWin();
      else soundService.playWin();
      triggerHaptic('success');
      toast.success(outcomeHeadline(result));
    }
    setClientSeed(randomClientSeed());
    if (result.free) setFreeMode(false); // the free spin is spent: the paid wheel returns
    if (clubUuid) {
      void loadState(clubUuid).catch((err) => reportError(err, 'DiamondWheelPage.reload'));
      void loadFree(clubUuid);
      void loadHistory(clubUuid);
      if (!result.free) void refreshFloor();
    }
    void freshCommit();
  }, [pending, toast, clubUuid, loadState, loadFree, loadHistory, freshCommit, refreshFloor]);

  const handleVerify = useCallback(
    async (result: WheelSpinResult) => {
      setVerifying(true);
      try {
        /* A free spin was drawn over the free table's weights, a paid one
           over the paid table's: the check walks the table the spin used. */
        const eligible = (result.free ? freeSegments : segments)
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
    [segments, freeSegments, live, toast]
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
    : freeMode
      ? 'Free Spin'
      : waitSeconds > 0
        ? `Ready In ${waitSeconds}s`
        : `Spin ${price.toLocaleString()}`;
  const pill = state.frozen
    ? 'Break'
    : state.available
      ? freeMode
        ? 'Free Spin'
        : 'Open'
      : state.reason === 'not_configured'
        ? 'Closed'
        : 'Paused';
  const pillInk = state.frozen ? 'gold' : state.available ? (freeMode ? 'gold' : 'green') : 'red';
  const wheelSize = Math.max(200, Math.min(340, stageWidth - 8));
  /* After the free spin, the idle line says when the next one comes. */
  const freeNote =
    !freeMode && free?.enabled && state.available
      ? free.reason === 'used'
        ? ' Your Free Spin Returns Tomorrow.'
        : free.reason === 'pot_empty'
          ? ' Today’s Free Spins Are Gone; They Return Tomorrow.'
          : free.reason === 'owner'
            ? ' The Club Pays The Free Spin, So Its Owner Does Not Take One.'
            : ''
      : '';
  const readoutSubCopy = lastResult
    ? lastResult.outcome.kind === 'nothing'
      ? 'Better Luck On The Next Spin'
      : lastResult.free
        ? 'Paid Into Your Diamonds, On The House'
        : lastResult.outcome.kind === 'diamonds'
          ? 'Paid Into Your Diamonds'
          : 'Paid Into Your Club Chips'
    : '';

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
        title="Diamond Wheel"
        titleId="diamond-wheel-title"
        pill={pill}
        pillInk={pillInk}
        aria-labelledby="diamond-wheel-title"
        bays={[
          { label: 'Diamonds', value: compactChips(player?.diamonds ?? 0), ink: 'blue' },
          { label: 'Chips', value: compactChips(player?.member_chips ?? 0), ink: 'silver' },
          freeMode
            ? { label: 'Spin', value: 'Free', ink: 'gold' }
            : { label: 'Spin', value: compactChips(price), ink: 'silver' },
          {
            label: 'Today',
            value: `${player?.spins_today ?? 0}/${cfg?.max_spins_per_player_per_day ?? 0}`,
            ink: 'muted',
          },
        ]}
        secondary={{
          label: 'Odds',
          onClick: () => oddsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        }}
        primary={{
          label: spinLabel,
          ink: freeMode ? 'gold' : 'white',
          onClick: handleSpin,
          disabled: !canSpin,
        }}
      >
        <div className={styles.stage} ref={stageRef}>
          <DiamondWheel
            segments={rim}
            free={face === 'free'}
            landingOrd={landingOrd}
            spinKey={spinKey}
            spinning={spinning}
            onLanded={handleLanded}
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
                : freeMode
                  ? 'Today’s Free Spin Is Yours. Five Prizes, All In Diamonds, And Every One Pays.'
                  : `Every Spin Is ${price.toLocaleString()} Diamonds. Eleven Prizes, ${cfg ? (cfg.hit_rate * 100).toFixed(0) : '76'}% Of Spins Pay, 80% Returned Over Time.${freeNote}`}
            </p>
          )}
        </div>
      </DeckConsole>

      <div ref={oddsRef}>
        <SpadeConsole
          eyebrow={freeMode ? 'On The House' : 'The Prizes'}
          title={freeMode ? 'Free Spin Odds' : 'Odds'}
          foot="foot"
        >
          <div className={styles.rows}>
            <div className={`${styles.grid4} ${styles.grid4Head}`}>
              <span className="sc-label sc-ink--blue">Prize</span>
              <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Odds</span>
              <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Chance</span>
              <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Worth</span>
            </div>
            {[...table]
              .sort((a, b) => b.value_chips - a.value_chips)
              .map((seg) => (
                <div key={seg.ord} className={styles.grid4}>
                  <span
                    className={`${styles.cell} ${seg.locked ? 'sc-ink--muted' : 'sc-ink--silver'}`}
                  >
                    {prizeLabel(seg)}
                    {seg.locked ? (
                      <span className={styles.rowMeta}>Locked Until The Club Can Cover It</span>
                    ) : null}
                  </span>
                  <span className={`${styles.cell} ${styles.cellRight} sc-ink--muted`}>
                    {odds(seg.probability)}
                  </span>
                  <span className={`${styles.cell} ${styles.cellRight} sc-ink--silver`}>
                    {(seg.probability * 100).toFixed(seg.probability < 0.01 ? 2 : 1)}%
                  </span>
                  <span className={`${styles.cell} ${styles.cellRight} sc-ink--gold`}>
                    {seg.kind === 'nothing' ? '' : worth(seg.value_chips)}
                  </span>
                </div>
              ))}
          </div>
          {freeMode ? (
            <p className="sc-copy">
              Today’s Free Spin Pays In Diamonds, On The Club, And Every Prize Pays. It Uses The
              Same Sealed Seed As A Paid Spin, So You Can Check It The Same Way. When It Lands, The
              Paid Wheel Returns With Its Eleven Prizes In Chips And Diamonds.
            </p>
          ) : (
            <p className="sc-copy">
              The Wheel Returns 80% Of Everything It Takes In Over Time And Never Pays Out More Than
              It Has Taken In. Every Prize Is Paid By The Club Itself, Out Of Its Promo Wallet. A
              Locked Prize Is One The Club Cannot Cover Right Now; It Unlocks When It Can.
              {state.pool && state.pool.spins > 0 && state.pool.realized_rtp !== null
                ? ` Realised Return So Far: ${(state.pool.realized_rtp * 100).toFixed(0)}% Over ${compactChips(state.pool.spins)} Spins.`
                : ''}
            </p>
          )}
        </SpadeConsole>
      </div>

      <SpadeConsole
        eyebrow="Provably Fair"
        title="Check Any Spin"
        plates={{
          secondary: {
            label: 'New Seed',
            onClick: () => setClientSeed(randomClientSeed()),
            disabled: spinning,
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
          Before You Spin, The Server Commits To A Secret Seed By Showing You Its SHA-256 Hash. Your
          Spin Reveals The Seed. The Result Is HMAC-SHA256(Server Seed, Your Seed:Nonce), Read As A
          Number From 0 To 2^48 And Mapped Onto The Prizes That Were Available.
        </p>
        <label className={styles.seedField}>
          <span className="sc-label sc-ink--blue">Your Client Seed</span>
          <input
            className={styles.seedInput}
            value={clientSeed}
            maxLength={MAX_CLIENT_SEED}
            onChange={(e) => setClientSeed(e.target.value)}
            disabled={spinning}
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
                {lastResult.free ? 'Server Seed (Free Spin)' : 'Server Seed'}
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
                    {h.free ? `Free Spin, ${historyTime(h.created_at)}` : historyTime(h.created_at)}
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
