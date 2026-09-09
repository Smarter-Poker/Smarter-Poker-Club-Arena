/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND GAMES - the lobby: Wheel, Plinko, Crash
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The player's one door to the three diamond-to-chip games (Dan 2026-09-07 and
 * 2026-09-08). Each tile reads its own state from the server so a game a host
 * has not opened says so instead of leading into a dead page. All three return
 * exactly 80 percent, take purchased diamonds by default, and never pay out
 * more than they have taken in; the tiles say that plainly because a player
 * who is not told the edge assumes the worst.
 *
 * Material: the approved #SmarterCasinoRealism chassis. Title Case copy, no
 * emoji, no em dashes.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import DiamondGamesHeader from '../components/diamond-games/DiamondGamesHeader';
import {
  CasinoBay,
  CasinoBays,
  CasinoButton,
  CasinoFrame,
  CasinoNote,
} from '../components/diamond-games/CasinoChassis';
import DiamondWheelService, { type WheelState } from '../services/DiamondWheelService';
import DiamondGamesService, { type GameState } from '../services/DiamondGamesService';
import { multiplierLabel } from '../utils/diamondGamesFairness';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import styles from '../components/diamond-games/gameDetails.module.css';

function availability(
  available: boolean | undefined,
  reason: string | undefined,
  frozen: boolean | undefined
): string {
  if (frozen) return 'Maintenance Break';
  if (available === undefined) return 'Loading';
  if (available) return 'Open';
  return reason === 'not_configured' ? 'Not Open Here' : 'Paused';
}

export default function DiamondGamesPage() {
  const { clubId: routeClubId } = useParams();
  const navigate = useNavigate();
  const isMountedRef = useIsMounted();
  const live = useCallback(() => isMountedRef.current, [isMountedRef]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wheel, setWheel] = useState<WheelState | null>(null);
  const [plinko, setPlinko] = useState<GameState | null>(null);
  const [crash, setCrash] = useState<GameState | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!routeClubId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const uuid = await resolveClubUUID(routeClubId);
        if (cancelled || !live()) return;
        const [w, p, c] = await Promise.all([
          DiamondWheelService.getState(uuid).catch((err) => {
            reportError(err, 'DiamondGamesPage.wheel');
            return null;
          }),
          DiamondGamesService.getState(uuid, 'plinko').catch((err) => {
            reportError(err, 'DiamondGamesPage.plinko');
            return null;
          }),
          DiamondGamesService.getState(uuid, 'crash').catch((err) => {
            reportError(err, 'DiamondGamesPage.crash');
            return null;
          }),
        ]);
        if (cancelled || !live()) return;
        setWheel(w);
        setPlinko(p);
        setCrash(c);
        if (!w && !p && !c) setLoadError('The Diamond Games Could Not Be Loaded');
      } catch (err) {
        reportError(err, 'DiamondGamesPage.load');
        if (!cancelled && live()) setLoadError('The Diamond Games Could Not Be Loaded');
      } finally {
        if (!cancelled && live()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeClubId, live]);

  if (loading) return <PageSkeleton />;
  if (loadError) {
    return (
      <div className={styles.page}>
        <ErrorState message={loadError} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  const player = plinko?.player ?? crash?.player ?? null;
  const diamonds = player?.diamonds ?? wheel?.player?.diamonds ?? 0;
  const spendable = player?.spendable ?? wheel?.player?.spendable ?? 0;
  const memberChips = player?.member_chips ?? wheel?.player?.member_chips ?? null;
  const purchasedOnly = Boolean(
    plinko?.config?.purchased_only ?? crash?.config?.purchased_only ?? wheel?.config?.purchased_only
  );
  const topWheel = wheel?.segments?.length
    ? Math.max(...wheel.segments.map((s) => s.value_chips))
    : 50;
  const plinkoTop = plinko?.tables?.length
    ? Math.max(...plinko.tables.map((t) => t.max_multiplier_cents))
    : 100000;
  const crashTop = crash?.config?.max_multiplier_cents ?? 100000;

  return (
    <div className={styles.page}>
      <DiamondGamesHeader
        eyebrow="Rewards Circuit"
        title="Diamond Games"
        diamonds={diamonds}
        spendable={spendable}
        memberChips={memberChips}
        purchasedOnly={purchasedOnly}
        backTo={`/clubs/${routeClubId}/promotions`}
        note={`Turn Diamonds Into Club Chips. Every Game Returns 80% Over Time, Is Provably Fair, And Never Pays Out More Than It Has Taken In.${purchasedOnly ? ' Purchased Diamonds Only.' : ''}`}
      />

      <div className={styles.lobbyGrid}>
        <CasinoFrame eyebrow="Spin" title="Diamond Wheel">
          <CasinoBays columns={3} className={styles.lobbyStats}>
            <CasinoBay
              label="Spin"
              value={`${(wheel?.config?.spin_price_diamonds ?? 100).toLocaleString()}`}
              sub="Diamonds"
              small
            />
            <CasinoBay
              label="Top Prize"
              value={`${topWheel.toLocaleString()}`}
              sub="Chips"
              tone="gold"
              small
            />
            <CasinoBay
              label="Status"
              value={availability(wheel?.available, wheel?.reason, wheel?.frozen)}
              sub="Right Now"
              tone={wheel?.available ? 'green' : 'chrome'}
              small
            />
          </CasinoBays>
          <CasinoButton
            wide
            onClick={() => navigate(`/clubs/${routeClubId}/wheel`)}
            disabled={!wheel?.available}
          >
            Spin The Wheel
          </CasinoButton>
          <CasinoNote>
            Eleven Prizes, Chips And Diamonds,{' '}
            {wheel?.config
              ? `${(wheel.config.hit_rate * 100).toFixed(0)}% Of Spins Pay`
              : 'Most Spins Pay'}
            .
          </CasinoNote>
        </CasinoFrame>

        <CasinoFrame eyebrow="Drop" title="Diamond Plinko">
          <CasinoBays columns={3} className={styles.lobbyStats}>
            <CasinoBay
              label="Bets From"
              value={`${(plinko?.config?.min_bet_diamonds ?? 100).toLocaleString()}`}
              sub="Diamonds"
              small
            />
            <CasinoBay
              label="Up To"
              value={multiplierLabel(plinkoTop)}
              sub="Moonshot"
              tone="gold"
              small
            />
            <CasinoBay
              label="Status"
              value={availability(plinko?.available, plinko?.reason, plinko?.frozen)}
              sub="Right Now"
              tone={plinko?.available ? 'green' : 'chrome'}
              small
            />
          </CasinoBays>
          <CasinoButton
            wide
            onClick={() => navigate(`/clubs/${routeClubId}/plinko`)}
            disabled={!plinko?.available}
          >
            Drop A Ball
          </CasinoButton>
          <CasinoNote>
            Three Boards, Sixteen Rows. The Edges Pay Big, The Centre Pays Nothing.
          </CasinoNote>
        </CasinoFrame>

        <CasinoFrame eyebrow="Climb" title="Diamond Crash">
          <CasinoBays columns={3} className={styles.lobbyStats}>
            <CasinoBay
              label="Bets From"
              value={`${(crash?.config?.min_bet_diamonds ?? 100).toLocaleString()}`}
              sub="Diamonds"
              small
            />
            <CasinoBay
              label="Up To"
              value={multiplierLabel(crashTop)}
              sub="Per Round"
              tone="gold"
              small
            />
            <CasinoBay
              label="Status"
              value={availability(crash?.available, crash?.reason, crash?.frozen)}
              sub="Right Now"
              tone={crash?.available ? 'green' : 'chrome'}
              small
            />
          </CasinoBays>
          <CasinoButton
            wide
            onClick={() => navigate(`/clubs/${routeClubId}/crash`)}
            disabled={!crash?.available}
          >
            Start A Round
          </CasinoButton>
          <CasinoNote>
            The Multiplier Climbs Until It Crashes. Cash Out First, By Hand Or On Auto.
          </CasinoNote>
        </CasinoFrame>
      </div>
    </div>
  );
}
