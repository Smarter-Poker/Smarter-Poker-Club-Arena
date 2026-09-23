import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND GAMES - the lobby: Wheel, Plinko, Crash, Donkey Cross, Mines
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The player's one door to the diamond-to-chip games (Dan 2026-09-07 and
 * 2026-09-08). Each console reads its own state from the server so a game a
 * host has not opened says so in its pill instead of leading into a dead page.
 * Every one of them takes purchased diamonds by default and never pays out more
 * than it has taken in.
 *
 * THE RULES COPY IS DERIVED, NOT TYPED (2026-09-19). Every figure in a "How It
 * Pays" panel comes from the constant the game actually plays: PLINKO_DROPS,
 * PLINKO_TABLES, ROAD_LADDERS and CHOICE_MODE. The page used to claim the
 * Plinko centre and a crash "pay nothing", and both were false the day the
 * guaranteed minimum shipped. A number written twice drifts; a number imported
 * cannot.
 *
 * AND SO ARE THE CRASH ODDS (fairness audit, 2026-09-22). "Instant Crash
 * 1 In 5" was typed here when a crash paid nothing. Every live round now funds
 * a guaranteed minimum out of its own odds, so it crashes at 1.00x 1 in 4.2 to
 * 4.3 of the time on an ordinary award and 1 in 2.4 on a Super one, and both
 * figures are computed here from the server's own minimum rule
 * (fn_diamond_bonus_minimum, mirrored by diamondBonusMinimum) across every
 * stake an award can be played at. "Up To" is the largest multiplier the
 * server is quoting for this game right now, not the configured ceiling: the
 * cap a round gets is set by the award it starts from.
 *
 * THE PICTURE (#ClubArenaConsole). A balances console that only closes, the
 * week's biggest wins, then one plated console per game: the figures on the
 * glass, the state in the pill, "How It Pays" on the steel plate, the game's
 * verb on the blue glass, and the floor's recent wins under them. Nothing
 * is drawn.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useIsMounted } from '../hooks/useIsMounted';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import { SpadeConsole, type ConsoleInk } from '../components/console/SpadeConsole';
import DiamondWheelService, {
  type WheelWelcomeState,
  type WheelState,
} from '../services/DiamondWheelService';
import DiamondGamesService, { type GameState } from '../services/DiamondGamesService';
import {
  awardInstantCrashChances,
  multiplierLabel,
  oneInRangeLabel,
} from '../utils/diamondGamesFairness';
import { compactChips } from '../utils/format';
import FloorFeed, { BiggestWins } from '../components/games/FloorFeed';
import { useGameFloor } from '../hooks/useGameFloor';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { DiamondChoiceService, type ChoiceState } from '../services/DiamondChoiceService';
import { PLINKO_DROPS } from '../utils/bonusGameBudget';
import { CHOICE_MODE, ROAD_LADDERS } from '../utils/diamondChoiceMath';
import { PLINKO_TABLES, plinkoTableVersion } from '../utils/diamondBonusPayout';
import { DIAMOND_GAME_TITLES } from '../utils/diamondGameTitles';
import styles from './diamondGames.module.css';

type GameKey = 'wheel' | 'plinko' | 'crash' | 'crossing' | 'mines';

/** "1.10x" and "20.00x": every multiplier in the rules copy reads with two decimals. */
const multiplierCopy = (cents: number) => `${(cents / 100).toFixed(2)}x`;
/** The one ladder the road deals: twelve streets, its first rung to its last. */
const ROAD = ROAD_LADDERS[CHOICE_MODE.crossing];
/** The two live boards. Nobody chooses one: the stake kind owns it. */
const ORDINARY_TABLE = PLINKO_TABLES[plinkoTableVersion(1)];
const SUPER_TABLE = PLINKO_TABLES[plinkoTableVersion(2)];
const TABLE_SLOTS = ORDINARY_TABLE.multipliersCents;
/** Seventeen slots need sixteen rows of pegs above them, so the board says both. */
const TABLE_ROWS = TABLE_SLOTS.length - 1;
/** The mines board is fixed at twenty-five tiles; mirrors minePrize and mineBoard. */
const MINE_TILES = 25;
/**
 * THE PROMISE EVERY BONUS GAME MAKES (2026-09-19). A losing round, and a round
 * a player never cashes out, still pays the server's guaranteed minimum, so no
 * game on this page pays nothing any more. A Super award's minimum is half its
 * doubled stake, which is the original spin back whole.
 */
const GUARANTEE_COPY =
  'A Loss, Or A Round You Do Not Cash Out, Still Pays The Guaranteed Minimum. On A Super Game That Minimum Is Worth Your Whole Original Spin.';
/**
 * SAID ONCE, ON THE GLASS (2026-09-19). There is no difficulty picker anywhere
 * in the bonus games: one road, one mine count, one board per stake kind, and
 * the payout carries the risk. The lobby says so where every player reads it,
 * rather than once inside each game's rules.
 */
const NO_DIFFICULTY_COPY = 'No Game Asks You To Pick A Difficulty. It Is Built Into The Payout.';

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
  const [wheelWelcome, setWheelWelcome] = useState<WheelWelcomeState | null>(null);
  const [plinko, setPlinko] = useState<GameState | null>(null);
  const [crash, setCrash] = useState<GameState | null>(null);
  const [crossing, setCrossing] = useState<ChoiceState | null>(null);
  const [mines, setMines] = useState<ChoiceState | null>(null);
  const [explained, setExplained] = useState<GameKey | null>(null);
  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const { floor } = useGameFloor(clubUuid, 20);

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
        const [w, wf, p, c, road, mine] = await Promise.all([
          DiamondWheelService.getState(uuid).catch((err) => {
            reportError(err, 'DiamondGamesPage.wheel');
            return null;
          }),
          DiamondWheelService.welcomeState(uuid).catch((err) => {
            reportError(err, 'DiamondGamesPage.wheelWelcome');
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
          // The one setting per game, never a difficulty the lobby picks.
          DiamondChoiceService.state(uuid, 'crossing', CHOICE_MODE.crossing, 100).catch((err) => {
            reportError(err, 'DiamondGamesPage.crossing');
            return null;
          }),
          DiamondChoiceService.state(uuid, 'mines', CHOICE_MODE.mines, 100).catch((err) => {
            reportError(err, 'DiamondGamesPage.mines');
            return null;
          }),
        ]);
        if (cancelled || !live()) return;
        setWheel(w);
        setWheelWelcome(wf);
        setPlinko(p);
        setCrash(c);
        setCrossing(road);
        setMines(mine);
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
  /**
   * THE CRASH FIGURES ARE THE SERVER'S, OR THEY ARE NOT SHOWN (2026-09-22).
   * The largest multiplier the server quotes on a playable bet right now, and
   * the instant-crash odds of the minimum it would seal on an ordinary and on a
   * Super award. The lobby holds no award of its own, so both odds are derived
   * from the game's configured bridge rate and the server's minimum rule, and
   * each is labelled for the award it belongs to.
   */
  const crashQuotes = (crash?.bets ?? []).filter((b) => b.playable).map((b) => b.cap_cents);
  const crashTop = crashQuotes.length ? Math.max(...crashQuotes) : null;
  const crashRate = crash?.config?.diamonds_per_chip ?? 0;
  const crashOdds = crashRate
    ? {
        ordinary: oneInRangeLabel(awardInstantCrashChances(1, crashRate)),
        super: oneInRangeLabel(awardInstantCrashChances(2, crashRate)),
      }
    : null;
  const welcomeReady = Boolean(wheel?.available && !wheel?.frozen && wheelWelcome?.available);
  const wheelPill = welcomeReady
    ? { pill: 'Welcome Spin', ink: 'gold' as ConsoleInk }
    : pillFor(wheel?.available, wheel?.reason, wheel?.frozen);
  /* The welcome spin's line on the glass: ready, spent, or gone for this window. */
  const welcomeRow: { value: string; ink: ConsoleInk } | null =
    wheel?.available && wheelWelcome?.enabled
      ? welcomeReady
        ? { value: 'Ready', ink: 'gold' }
        : wheelWelcome.reason === 'used'
          ? { value: 'Used', ink: 'muted' }
          : wheelWelcome.reason === 'pot_empty'
            ? { value: 'Gone For Today', ink: 'muted' }
            : null
      : null;
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

      <DiamondSpinsTabs clubId={routeClubId ?? ''} />
      <SpadeConsole
        eyebrow="Rewards Circuit"
        title="Diamond Spins"
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
          Turn Diamonds Into Club Chips. Choose Your Game, Set Your Bet, And Check Every Result.{' '}
          {NO_DIFFICULTY_COPY}
        </p>
      </SpadeConsole>

      <BiggestWins wins={floor?.top_week ?? []} />

      <SpadeConsole
        eyebrow="Spin"
        title="Diamond Spins"
        pill={wheelPill.pill}
        pillInk={wheelPill.ink}
        plates={{
          secondary: { label: 'How It Pays', onClick: () => explain('wheel') },
          primary: {
            label: welcomeReady ? 'Welcome Spin' : 'Spin',
            ink: welcomeReady ? 'gold' : 'white',
            onClick: () => navigate(`/clubs/${routeClubId}/wheel`),
            disabled: !wheel?.available,
          },
        }}
      >
        <div className={styles.rows}>
          {welcomeRow ? (
            <Row
              label="Welcome Spin"
              value={welcomeRow.value}
              ink={welcomeRow.ink}
              meta="One Welcome Spin, Ever"
            />
          ) : null}
          <Row
            label="A Spin"
            value={compactChips(wheel?.config?.spin_price_diamonds ?? 100)}
            ink="white"
            meta="Diamonds"
          />
          <Row label="Top Prize" value={compactChips(topWheel)} ink="gold" meta="Chips" />
        </div>
        {explained === 'wheel' ? (
          <p className="sc-copy">
            Eleven Prizes In Chips And Diamonds. The Wheel Lands Where The Server’s Sealed Seed
            Says, You Can Check Every Spin, And The Prizes Are Trimmed To What The Pool Can Pay.
            {wheelWelcome?.enabled
              ? ' Every New Member Also Gets One Welcome Spin, On The Club.'
              : ''}
          </p>
        ) : null}
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Drop"
        title={DIAMOND_GAME_TITLES.plinko}
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
            meta={`On The ${ORDINARY_TABLE.name} Board`}
          />
          <Row
            label="Drops"
            value={String(PLINKO_DROPS)}
            ink="silver"
            meta="Your Entry Split Equally"
          />
        </div>
        {explained === 'plinko' ? (
          <p className="sc-copy">
            Your Entry Plays As {PLINKO_DROPS} Drops, Each An Equal Share Of It, On One Board. That
            Board Is The {ORDINARY_TABLE.name} Board, {TABLE_ROWS} Rows Of Pegs Above{' '}
            {TABLE_SLOTS.length} Slots, And The Ball Goes Left Or Right At Every Peg With Equal
            Odds. Every Slot Pays Something, From {multiplierCopy(Math.min(...TABLE_SLOTS))} In The
            Middle Up To {multiplierCopy(Math.max(...TABLE_SLOTS))} Per Drop On The Outer Slots. A
            Super Award Plays The {SUPER_TABLE.name} Board, Where The Middle Slot Pays{' '}
            {multiplierCopy(Math.min(...SUPER_TABLE.multipliersCents))}. {GUARANTEE_COPY}
          </p>
        ) : null}
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Climb"
        title={DIAMOND_GAME_TITLES.crash}
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
          {crashTop === null ? null : (
            <Row
              label="Up To"
              value={multiplierLabel(crashTop)}
              ink="gold"
              meta="Set By Your Award"
            />
          )}
          {crashOdds ? (
            <Row
              label="Instant Crash"
              value={crashOdds.ordinary}
              ink="silver"
              meta="On An Ordinary Award"
            />
          ) : null}
        </div>
        {explained === 'crash' ? (
          <p className="sc-copy">
            The Multiplier Climbs Until It Crashes. Cash Out First, By Hand Or On Auto, And The
            Round Pays Exactly Where You Cashed Out. {GUARANTEE_COPY}
            {crashOdds
              ? ` That Minimum Is Paid For Out Of The Odds, So A Round Crashes At 1.00x ${crashOdds.ordinary} On An Ordinary Award And ${crashOdds.super} On A Super Award.`
              : ''}
          </p>
        ) : null}
      </SpadeConsole>

      {(
        [
          {
            key: 'crossing',
            title: DIAMOND_GAME_TITLES.crossing,
            state: crossing,
            verb: 'Cross',
            description: `Guide The Donkey Across ${ROAD.length} Streets, Paying ${multiplierCopy(ROAD[0])} Up To ${multiplierCopy(ROAD[ROAD.length - 1])}. Each Safe Street Raises Your Prize, And You Book Your Win After Any Street. The Reveal Then Shows How Far It Would Have Gone. ${GUARANTEE_COPY}`,
          },
          {
            key: 'mines',
            title: DIAMOND_GAME_TITLES.mines,
            state: mines,
            verb: 'Reveal',
            description: `${CHOICE_MODE.mines} Mines Hide Among ${MINE_TILES} Tiles. Every Gem You Find Raises Your Prize, And You Book Your Win After Any Tile. Every Remaining Mine Is Revealed When Your Round Ends. ${GUARANTEE_COPY}`,
          },
        ] as const
      ).map((item) => (
        <SpadeConsole
          key={item.key}
          title={item.title}
          eyebrow={item.verb}
          pill={item.state?.available ? 'Open' : item.state ? 'Closed' : 'Offline'}
          plates={{
            secondary: { label: 'How It Plays', onClick: () => explain(item.key) },
            primary: {
              label: item.verb,
              onClick: () => {
                if (item.key === 'crossing') navigate(`/clubs/${routeClubId}/crossing`);
                else navigate(`/clubs/${routeClubId}/mines`);
              },
              disabled: !item.state?.available,
            },
          }}
        >
          <div className={styles.rows}>
            <Row
              label="Bets From"
              value={compactChips(item.state?.bets[0] ?? 100)}
              meta="Diamonds"
              ink="white"
            />
            <Row label="Book The Win" value="Your Choice" ink="gold" />
          </div>
          {explained === item.key ? <p className="sc-copy">{item.description}</p> : null}
        </SpadeConsole>
      ))}

      <FloorFeed wins={floor?.wins ?? []} limit={8} />
    </div>
  );
}
