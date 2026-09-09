/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND GAMES - the lobby: Wheel, Plinko, Crash, on the console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The player's one door to the three diamond-to-chip games (Dan 2026-09-07 and
 * 2026-09-08). Each console reads its own state from the server so a game a
 * host has not opened says so in its pill instead of leading into a dead page.
 * All three return exactly 80 percent, take purchased diamonds by default, and
 * never pay out more than they have taken in; the page says that plainly
 * because a player who is not told the edge assumes the worst.
 *
 * THE PICTURE (#ClubArenaConsole). A balances console that only closes, then
 * one plated console per game: the figures on the glass, the state in the
 * pill, "How It Pays" on the steel plate, the game's verb on the blue glass.
 * Nothing is drawn.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import { SpadeConsole, type ConsoleInk } from '../components/console/SpadeConsole';
import DiamondWheelService, { type WheelState } from '../services/DiamondWheelService';
import DiamondGamesService, { type GameState } from '../services/DiamondGamesService';
import { multiplierLabel } from '../utils/diamondGamesFairness';
import { compactChips } from '../utils/format';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import styles from './diamondGames.module.css';

type GameKey = 'wheel' | 'plinko' | 'crash';

function pillFor(
  available: boolean | undefined,
  reason: string | undefined,
  frozen: boolean | undefined
): { pill: string; ink: ConsoleInk } {
  if (frozen) return { pill: 'Break', ink: 'gold' };
  if (available === undefined) return { pill: 'Offline', ink: 'muted' };
  if (available) return { pill: 'Open', ink: 'green' };
  return reason === 'not_configured'
    ? { pill: 'Closed', ink: 'muted' }
    : { pill: 'Paused', ink: 'red' };
}

function Row({
  label,
  value,
  ink = 'silver',
  meta,
}: {
  label: string;
  value: string;
  ink?: ConsoleInk;
  meta?: string;
}) {
  return (
    <div className={styles.row}>
      <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>
        {label}
        {meta ? <span className={`${styles.rowMeta} sc-ink--muted`}>{meta}</span> : null}
      </span>
      <span className={`${styles.rowValue} sc-ink--${ink}`}>{value}</span>
    </div>
  );
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
  const [explained, setExplained] = useState<GameKey | null>(null);

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
  const rate = plinko?.config?.diamonds_per_chip ?? crash?.config?.diamonds_per_chip ?? 100;
  const topWheel = wheel?.segments?.length
    ? Math.max(...wheel.segments.map((s) => s.value_chips))
    : 50;
  const plinkoTop = plinko?.tables?.length
    ? Math.max(...plinko.tables.map((t) => t.max_multiplier_cents))
    : 100000;
  const crashTop = crash?.config?.max_multiplier_cents ?? 100000;
  const wheelPill = pillFor(wheel?.available, wheel?.reason, wheel?.frozen);
  const plinkoPill = pillFor(plinko?.available, plinko?.reason, plinko?.frozen);
  const crashPill = pillFor(crash?.available, crash?.reason, crash?.frozen);
  const explain = (key: GameKey) => setExplained((cur) => (cur === key ? null : key));

  return (
    <div className={styles.page}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(`/clubs/${routeClubId}/promotions`)}
      >
        ‹ Promotions
      </button>

      <SpadeConsole
        eyebrow="Rewards Circuit"
        title="Diamond Games"
        titleId="diamond-games-title"
        subtitle={`${compactChips(rate)} Diamonds Make One Chip`}
        foot="foot"
        aria-labelledby="diamond-games-title"
      >
        <div className={styles.rows}>
          <Row label="Your Diamonds" value={compactChips(diamonds)} ink="blue" />
          {purchasedOnly ? (
            <Row
              label="Ready To Play"
              value={compactChips(spendable)}
              ink="white"
              meta="Purchased Diamonds Only"
            />
          ) : null}
          <Row
            label="Club Chips"
            value={memberChips === null ? 'Join To Play' : compactChips(memberChips)}
            ink="silver"
          />
        </div>
        <p className="sc-copy">
          Turn Diamonds Into Club Chips. Every Game Returns 80% Over Time, Is Provably Fair, And
          Never Pays Out More Than It Has Taken In.
        </p>
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Spin"
        title="Diamond Wheel"
        pill={wheelPill.pill}
        pillInk={wheelPill.ink}
        plates={{
          secondary: { label: 'How It Pays', onClick: () => explain('wheel') },
          primary: {
            label: 'Spin',
            ink: 'white',
            onClick: () => navigate(`/clubs/${routeClubId}/wheel`),
            disabled: !wheel?.available,
          },
        }}
      >
        <div className={styles.rows}>
          <Row
            label="A Spin"
            value={compactChips(wheel?.config?.spin_price_diamonds ?? 100)}
            ink="white"
            meta="Diamonds"
          />
          <Row label="Top Prize" value={compactChips(topWheel)} ink="gold" meta="Chips" />
          <Row
            label="Spins That Pay"
            value={wheel?.config ? `${Math.round(wheel.config.hit_rate * 100)}%` : 'Most'}
            ink="silver"
          />
        </div>
        {explained === 'wheel' ? (
          <p className="sc-copy">
            Eleven Prizes In Chips And Diamonds. The Wheel Lands Where The Server’s Sealed Seed
            Says, You Can Check Every Spin, And The Prizes Are Trimmed To What The Pool Can Pay.
          </p>
        ) : null}
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Drop"
        title="Diamond Plinko"
        pill={plinkoPill.pill}
        pillInk={plinkoPill.ink}
        plates={{
          secondary: { label: 'How It Pays', onClick: () => explain('plinko') },
          primary: {
            label: 'Drop',
            ink: 'white',
            onClick: () => navigate(`/clubs/${routeClubId}/plinko`),
            disabled: !plinko?.available,
          },
        }}
      >
        <div className={styles.rows}>
          <Row
            label="Bets From"
            value={compactChips(plinko?.config?.min_bet_diamonds ?? 100)}
            ink="white"
            meta="Diamonds"
          />
          <Row
            label="Up To"
            value={multiplierLabel(plinkoTop)}
            ink="gold"
            meta="On The Moonshot Board"
          />
          <Row label="Boards" value={String(plinko?.tables?.length ?? 3)} ink="silver" />
        </div>
        {explained === 'plinko' ? (
          <p className="sc-copy">
            Three Boards, Sixteen Rows, Seventeen Slots. The Ball Goes Left Or Right At Every Peg
            With Equal Odds, So The Edges Pay Big And The Centre Pays Nothing.
          </p>
        ) : null}
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Climb"
        title="Diamond Crash"
        pill={crashPill.pill}
        pillInk={crashPill.ink}
        plates={{
          secondary: { label: 'How It Pays', onClick: () => explain('crash') },
          primary: {
            label: 'Start',
            ink: 'white',
            onClick: () => navigate(`/clubs/${routeClubId}/crash`),
            disabled: !crash?.available,
          },
        }}
      >
        <div className={styles.rows}>
          <Row
            label="Bets From"
            value={compactChips(crash?.config?.min_bet_diamonds ?? 100)}
            ink="white"
            meta="Diamonds"
          />
          <Row label="Up To" value={multiplierLabel(crashTop)} ink="gold" meta="Per Round" />
          <Row label="Instant Crash" value="1 In 5" ink="silver" />
        </div>
        {explained === 'crash' ? (
          <p className="sc-copy">
            The Multiplier Climbs Until It Crashes. Cash Out First, By Hand Or On Auto. The Chance
            Of Reaching Any Multiplier Is 80% Divided By That Multiplier.
          </p>
        ) : null}
      </SpadeConsole>
    </div>
  );
}
