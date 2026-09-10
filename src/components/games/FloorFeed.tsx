/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FLOOR - other people winning, printed on the glass
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A casino floor is loud with other people winning; an empty room is not a
 * casino. This prints the host's recent wins across the wheel, the board and
 * the curve as engraved rows on a console: who (the club's own name for them),
 * which game, when, and what it paid, the prize in the ink the master gives
 * it (gold for chips, blue for diamonds). Your own wins print in white.
 *
 * Nothing here is drawn. The avatar is the club's arena avatar art, the same
 * picture the felt shows, resolved through getAvatarWithFallback exactly as
 * SeatSlot and the BBJ hits do it (absolute Hub origin, a deterministic
 * monogram when a winner has not picked one).
 */

import { SpadeConsole } from '../console/SpadeConsole';
import type { FloorWin } from '../../services/DiamondGamesService';
import { multiplierLabel } from '../../utils/diamondGamesFairness';
import { compactChips } from '../../utils/format';
import { getAvatarWithFallback } from '../../utils/avatarGenerator';
import styles from '../../pages/diamondGames.module.css';

const GAME_WORD: Record<FloorWin['game'], string> = {
  wheel: 'Diamond Wheel',
  plinko: 'Diamond Plinko',
  crash: 'Diamond Crash',
};

/** Chips as the player reads them: whole figures compact, a fractional prize exact (it IS the prize). */
function chipsLabel(v: number): string {
  return Number.isInteger(v) ? compactChips(v) : v.toFixed(2);
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'Just Now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m Ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h Ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : `${d}d Ago`;
}

export function prizeLabel(w: FloorWin): string {
  if (w.kind === 'diamonds') return `${compactChips(w.amount)} Diamonds`;
  const chips = `${chipsLabel(w.value_chips)} ${w.value_chips === 1 ? 'Chip' : 'Chips'}`;
  return w.multiplier_cents ? `${multiplierLabel(w.multiplier_cents)} For ${chips}` : chips;
}

/** The rows themselves: who, which game, when, what it paid. Shared with the week's board. */
export function FloorRows({
  rows,
  game,
  ranked = false,
}: {
  rows: FloorWin[];
  /** One game's rows: the meta line then carries only the time. */
  game?: FloorWin['game'];
  /** Print the position: the board is an order, the feed is a stream. */
  ranked?: boolean;
}) {
  return (
    <div className={`${styles.rows} ${styles.rowsCompact}`}>
      {rows.map((w, i) => (
        <div key={`${w.at}-${i}`} className={styles.row}>
          <span className={`${styles.rowLabel} ${w.mine ? 'sc-ink--white' : 'sc-ink--silver'}`}>
            {ranked ? <span className={`${styles.rowRank} sc-ink--blue`}>{i + 1}</span> : null}
            <img
              className={styles.rowAvatar}
              src={getAvatarWithFallback(w.avatar, w.name, w.name, 24)}
              alt=""
              aria-hidden="true"
            />
            {w.mine ? 'You' : w.name}
            <span className={`${styles.rowMeta} sc-ink--muted`}>
              {game ? timeAgo(w.at) : `${GAME_WORD[w.game]}, ${timeAgo(w.at)}`}
            </span>
          </span>
          <span
            className={`${styles.rowValue} ${w.kind === 'diamonds' ? 'sc-ink--blue' : 'sc-ink--gold'}`}
          >
            {prizeLabel(w)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function FloorFeed({
  wins,
  title = 'Recent Wins',
  eyebrow = 'The Floor',
  limit = 10,
  game,
}: {
  wins: FloorWin[];
  title?: string;
  eyebrow?: string;
  limit?: number;
  /** Show one game's wins only; every game when omitted. */
  game?: FloorWin['game'];
}) {
  const rows = (game ? wins.filter((w) => w.game === game) : wins).slice(0, limit);
  return (
    <SpadeConsole eyebrow={eyebrow} title={title} foot="foot">
      {rows.length === 0 ? (
        <p className="sc-copy sc-copy--center sc-ink--muted">
          {game
            ? 'No Wins On This Game Yet. Yours Could Be The First.'
            : 'No Wins Yet. Yours Could Be The First.'}
        </p>
      ) : (
        <FloorRows rows={rows} game={game} />
      )}
    </SpadeConsole>
  );
}

/**
 * The week's board: the host's five biggest wins of the last seven days,
 * biggest first, straight from fn_diamond_game_floor's top_week. A recent
 * win is small more often than not; this is the one the room talks about.
 */
export function BiggestWins({ wins }: { wins: FloorWin[] }) {
  return (
    <SpadeConsole eyebrow="This Week" title="Biggest Wins" foot="foot">
      {wins.length === 0 ? (
        <p className="sc-copy sc-copy--center sc-ink--muted">
          No Wins This Week Yet. Yours Could Be The First.
        </p>
      ) : (
        <FloorRows rows={wins.slice(0, 5)} ranked />
      )}
    </SpadeConsole>
  );
}
