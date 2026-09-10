/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DIAMONDS TO CHIPS - the door, wherever a player runs out
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-10: "when a player is out of chips or doesn't have enough to
 * rebuy into a tournament or rebuy into a cash game, they be prompted to play
 * diamonds to chips. there also needs to be a button for this inside the club
 * lobby."
 *
 * One button, four places: the club lobby, the cash buy-in, the tournament
 * rebuy and add-on, and the sign-up dialog. It is the painted action shell
 * (#SmarterCasinoRealism), never a CSS button, and it says what the player
 * actually holds - the diamonds and what they are worth in chips at the
 * bridge rate - because "play diamonds to chips" means nothing to somebody
 * who does not know they have any.
 *
 * IT ONLY APPEARS WHEN IT IS TRUE. The host must have a game open, the player
 * must be a member, and in the prompt places they must hold enough diamonds to
 * get in; otherwise this renders nothing rather than leading into a dead page.
 * The lobby is the exception: `alwaysShow` keeps the club's own door in its
 * place, and the figures fill in when the read lands.
 */

import { ArenaActionButton, ClubButtonsSurface } from '../club-buttons';
import { useDiamondGamesEntry } from '../../hooks/useDiamondGamesEntry';
import { compactChips } from '../../utils/format';
import type { DiamondGamesEntry } from '../../services/DiamondGamesService';

/** Whole chips print compact; a fraction prints exact, because it IS the amount. */
function chipsLabel(v: number): string {
  return Number.isInteger(v) ? compactChips(v) : v.toFixed(2);
}

export function entrySublabel(entry: DiamondGamesEntry | null): string {
  if (!entry) return 'Turn Diamonds Into Chips';
  if (entry.diamonds <= 0) return 'Win Diamonds, Then Turn Them Into Chips';
  return `${compactChips(entry.diamonds)} Diamonds, Up To ${chipsLabel(entry.chips_from_diamonds)} Chips`;
}

/** The player can get in: a game is open to them and they hold the cheapest way in. */
export function canEnterDiamondGames(entry: DiamondGamesEntry | null): boolean {
  return Boolean(
    entry &&
    entry.available &&
    entry.entry_diamonds !== null &&
    entry.diamonds >= entry.entry_diamonds
  );
}

export interface DiamondsToChipsButtonProps {
  /** The club the player is in. Its host (a union, or the club itself) runs the games. */
  clubId: string | null | undefined;
  /** Called with the games path. The caller decides whether to close a modal first. */
  onGo: (path: string) => void;
  /** Read the door now (a modal passes false until it opens). */
  enabled?: boolean;
  /** The lobby keeps its door whatever the read says; a prompt does not. */
  alwaysShow?: boolean;
  label?: string;
  size?: 'compact' | 'regular' | 'large';
  className?: string;
}

export default function DiamondsToChipsButton({
  clubId,
  onGo,
  enabled = true,
  alwaysShow = false,
  label = 'Diamonds To Chips',
  size = 'regular',
  className,
}: DiamondsToChipsButtonProps) {
  const { entry } = useDiamondGamesEntry(clubId, enabled);
  if (!clubId) return null;
  if (!alwaysShow && !canEnterDiamondGames(entry)) return null;
  return (
    <ClubButtonsSurface className={className ?? 'diamonds-to-chips'}>
      <ArenaActionButton
        icon="diamond"
        label={entry?.free_spin_ready ? 'Free Spin Ready' : label}
        sublabel={entrySublabel(entry)}
        size={size}
        value={entry ? compactChips(entry.diamonds) : undefined}
        onClick={() => onGo(`/clubs/${clubId}/diamond-games`)}
      />
    </ClubButtonsSurface>
  );
}
