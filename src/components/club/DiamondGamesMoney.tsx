/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE OPERATOR'S MONEY AND ROOM (Phase 3, 2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three readings an operator had no way to get, on the painted chassis, shared
 * by both Diamond Games consoles so the wheel page and the games page cannot
 * drift apart:
 *
 *   THE MONEY   what the host is up or down across all three games, over four
 *               windows. Balances are a photograph and the realised-return
 *               windows are about fairness, not money: they do not count the
 *               diamond prizes at all, so the one figure an owner cares about
 *               appeared nowhere.
 *
 *   THE ROOM    how much game is left in the cover. The cover reading goes red
 *               at zero, by which time the games have been refusing bets for a
 *               while, because each caps the multiplier it offers by what the
 *               cover can pay. This sits between "fine" and "stopped", and it
 *               says WHICH ceiling is binding: the intake headroom, which is
 *               the never-pay-more-than-taken-in law working and nothing to act
 *               on, or the cover, which is the operator's to fix.
 *
 *   THE PLAYERS per-player daily caps have existed since the games opened and
 *               no surface ever showed an operator who was near one.
 *
 * Nothing here runs on a schedule. CLAUDE.md 10.12 forbids a monitor or an
 * alert presented as the resolution; these are computed when the operator opens
 * the page they already open, out of rows the games already wrote.
 */
import { useCallback, useEffect, useState } from 'react';
import { SpadeConsole, type ConsoleInk } from '../console/SpadeConsole';
import DiamondGamesService, {
  type GamePnl,
  type GamePlayers,
  type GameRoom,
  type GameRoomState,
} from '../../services/DiamondGamesService';
import { compactChips } from '../../utils/format';
import { reportError } from '../../utils/errorReporter';
import { useIsMounted } from '../../hooks/useIsMounted';
import styles from '../../pages/diamondGames.module.css';

const chips = (n: number | null | undefined) => compactChips(Number(n ?? 0));
const GAME_WORD: Record<string, string> = { wheel: 'Wheel', plinko: 'Plinko', crash: 'Crash' };
const gameWord = (g: string) => GAME_WORD[g] ?? g;

const STATE_INK: Record<GameRoomState, ConsoleInk> = {
  open: 'green',
  thin: 'gold',
  stopped: 'red',
  closed: 'muted',
};
const STATE_WORD: Record<GameRoomState, string> = {
  open: 'Open',
  thin: 'Thin',
  stopped: 'Stopped',
  closed: 'Closed',
};

/** The worst state any game is in, which is what the header should say. */
function worstState(room: GameRoom | null): GameRoomState {
  if (!room || room.games.length === 0) return 'closed';
  const live = room.games.filter((g) => g.enabled);
  if (live.length === 0) return 'closed';
  if (live.some((g) => g.state === 'stopped')) return 'stopped';
  if (live.some((g) => g.state === 'thin')) return 'thin';
  return 'open';
}

function Head({ cells }: { cells: string[] }) {
  return (
    <div className={`${styles.grid4} ${styles.grid4Head}`}>
      {cells.map((c, i) => (
        <span key={c} className={`sc-label sc-ink--blue ${i === 0 ? '' : styles.cellRight}`}>
          {c}
        </span>
      ))}
    </div>
  );
}

export default function DiamondGamesMoney({ clubId }: { clubId: string | null }) {
  const isMountedRef = useIsMounted();
  const [pnl, setPnl] = useState<GamePnl | null>(null);
  const [room, setRoom] = useState<GameRoom | null>(null);
  const [players, setPlayers] = useState<GamePlayers | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!clubId) return;
    setLoading(true);
    try {
      const [p, r, w] = await Promise.all([
        DiamondGamesService.pnl(clubId).catch((err) => {
          reportError(err, 'DiamondGamesMoney.pnl', { clubId });
          return null;
        }),
        DiamondGamesService.room(clubId).catch((err) => {
          reportError(err, 'DiamondGamesMoney.room', { clubId });
          return null;
        }),
        DiamondGamesService.players(clubId, 25).catch((err) => {
          reportError(err, 'DiamondGamesMoney.players', { clubId });
          return null;
        }),
      ]);
      if (!isMountedRef.current) return;
      setPnl(p);
      setRoom(r);
      setPlayers(w);
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [clubId, isMountedRef]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!clubId) return null;

  const state = worstState(room);
  const day = pnl?.windows.find((w) => w.window === '24 Hours') ?? null;
  const roster = players?.players ?? [];

  return (
    <>
      <SpadeConsole
        eyebrow="Diamonds In, Chips Out"
        title="The Money"
        pill={day ? (day.net_chips >= 0 ? 'Up Today' : 'Down Today') : 'No Rounds Yet'}
        pillInk={day && day.net_chips < 0 ? 'red' : 'green'}
        foot="foot"
      >
        <p className="sc-copy">
          What The Games Earned You, Not What They Paid Back. Every Diamond Taken In Went To The
          Owner Wallet; Every Chip Paid Left The Promo Wallet Or The Bank; Diamond Prizes Came Out
          Of The Owner Balance. Welcome Spins Are Shown Apart, Because They Are A Gift You Chose To
          Make Rather Than The Paid Game Losing Money.
        </p>
        <div className={styles.rows}>
          <Head cells={['Window', 'Rounds', 'Taken In', 'Net']} />
          {(pnl?.windows ?? []).map((w) => (
            <div key={w.window} className={styles.grid4}>
              <span className={styles.cell}>{w.window}</span>
              <span className={`${styles.cell} ${styles.cellRight}`}>{w.rounds}</span>
              <span className={`${styles.cell} ${styles.cellRight}`}>{chips(w.intake_chips)}</span>
              <span
                className={`${styles.cell} ${styles.cellRight} sc-ink--${
                  w.net_chips >= 0 ? 'green' : 'red'
                }`}
              >
                {chips(w.net_chips)}
              </span>
            </div>
          ))}
          {day ? (
            <>
              <Head cells={['Today, By Game', 'Rounds', 'Paid Out', 'Net']} />
              {day.games.map((g) => (
                <div key={g.game} className={styles.grid4}>
                  <span className={styles.cell}>{gameWord(g.game)}</span>
                  <span className={`${styles.cell} ${styles.cellRight}`}>{g.rounds}</span>
                  <span className={`${styles.cell} ${styles.cellRight}`}>
                    {chips(g.chips_paid)}
                  </span>
                  <span
                    className={`${styles.cell} ${styles.cellRight} sc-ink--${
                      g.net_chips >= 0 ? 'green' : 'red'
                    }`}
                  >
                    {chips(g.net_chips)}
                  </span>
                </div>
              ))}
              {day.welcome_chips > 0 ? (
                <div className={styles.row}>
                  <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>
                    Welcome Spins Today
                    <span className={`${styles.rowMeta} sc-ink--muted`}>
                      Given Away, Not Lost At The Table
                    </span>
                  </span>
                  <span className={`${styles.rowValue} sc-ink--gold`}>
                    {chips(day.welcome_chips)}
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
          {!pnl && !loading ? <p className="sc-copy sc-ink--muted">No Figures Yet.</p> : null}
        </div>
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Before It Stops"
        title="The Room"
        pill={STATE_WORD[state]}
        pillInk={STATE_INK[state]}
        foot="foot"
      >
        <p className="sc-copy">
          Top Win Is The Biggest A Player Could Take Right Now At Your Largest Bet, Against The
          Ceiling Your Settings Allow. Every Game Caps What It Offers By What Your Cover Can Pay, So
          A Game Goes Quiet Long Before The Cover Reads Zero. Thin Means The Cover Is What Is
          Holding The Top Prize Down And More Chips In The Promo Wallet Would Lift It. A Game Held
          Down By Its Own Intake Instead Is The House Rule Working, And Needs Nothing From You.
        </p>
        <div className={styles.rows}>
          <Head cells={['Game', 'Top Win', 'Ceiling', 'State']} />
          {(room?.games ?? []).map((g) => (
            <div key={g.game} className={styles.grid4}>
              <span className={styles.cell}>{gameWord(g.game)}</span>
              <span className={`${styles.cell} ${styles.cellRight}`}>
                {g.game === 'wheel' ? chips(g.top_chip_prize_chips) : chips(g.max_win_chips)}
              </span>
              <span className={`${styles.cell} ${styles.cellRight} ${styles.cellDim}`}>
                {g.game === 'wheel' ? 'Fixed Table' : chips(g.ceiling_win_chips)}
              </span>
              <span className={`${styles.cell} ${styles.cellRight} sc-ink--${STATE_INK[g.state]}`}>
                {STATE_WORD[g.state]}
              </span>
            </div>
          ))}
          {(room?.games ?? [])
            .filter((g) => g.enabled && g.capped_by_cover)
            .map((g) => (
              <div key={`${g.game}-why`} className={styles.row}>
                <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>
                  {gameWord(g.game)}
                  <span className={`${styles.rowMeta} sc-ink--muted`}>
                    The Cover Is Holding This One Down
                  </span>
                </span>
                <span className={`${styles.rowValue} sc-ink--gold`}>
                  {chips(g.max_win_chips)} Of {chips(g.intake_win_chips)}
                </span>
              </div>
            ))}
          {(room?.games ?? []).some(
            (g) => g.game === 'wheel' && g.enabled && g.diamond_prize_covered === false
          ) ? (
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>
                Owner Diamonds
                <span className={`${styles.rowMeta} sc-ink--muted`}>
                  The Wheel Pays Its Diamond Prizes From Here
                </span>
              </span>
              <span className={`${styles.rowValue} sc-ink--red`}>
                {compactChips(room?.owner_diamonds ?? 0)} Will Not Cover The Top Diamond Prize
              </span>
            </div>
          ) : null}
        </div>
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Today"
        title="Who Is Playing"
        pill={`${roster.length}`}
        pillInk={roster.some((p) => p.at_spin_cap || p.at_round_cap) ? 'gold' : 'blue'}
        foot="foot"
      >
        <p className="sc-copy">
          Everyone Who Has Played This Host Today, Biggest Spender First, Against The Two Daily
          Ceilings. Net Is From The Player Side: A Positive Number Means They Are Ahead.
        </p>
        <div className={styles.rows}>
          <Head cells={['Player', 'Rounds', 'Spent', 'Net']} />
          {roster.map((p) => (
            <div key={p.user_id} className={styles.grid4}>
              <span className={styles.cell}>{p.name}</span>
              <span
                className={`${styles.cell} ${styles.cellRight} ${
                  p.at_spin_cap || p.at_round_cap ? 'sc-ink--gold' : ''
                }`}
              >
                {p.spins + p.rounds}
              </span>
              <span className={`${styles.cell} ${styles.cellRight}`}>{chips(p.spent_chips)}</span>
              <span
                className={`${styles.cell} ${styles.cellRight} sc-ink--${
                  p.net_chips >= 0 ? 'green' : 'muted'
                }`}
              >
                {chips(p.net_chips)}
              </span>
            </div>
          ))}
          {roster.length === 0 ? (
            <p className="sc-copy sc-ink--muted">Nobody Has Played Here Today.</p>
          ) : null}
          {roster.some((p) => p.at_spin_cap || p.at_round_cap) ? (
            <div className={styles.row}>
              <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>
                At The Daily Ceiling
              </span>
              <span className={`${styles.rowValue} sc-ink--gold`}>
                {roster.filter((p) => p.at_spin_cap || p.at_round_cap).length}
              </span>
            </div>
          ) : null}
        </div>
      </SpadeConsole>
    </>
  );
}
