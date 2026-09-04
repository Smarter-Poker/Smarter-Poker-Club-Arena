/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CREATE TABLE PAGE — Game Type Selector
 * ═══════════════════════════════════════════════════════════════════════════════
 * premium-style game type selection with 7 game options:
 * - NLH (No Limit Hold'em)
 * - FLH (Fixed Limit Hold'em)
 * - 6+ (Short Deck Hold'em)
 * - OMAHA (Pot Limit Omaha)
 * - FLO (Fixed Limit Omaha)
 * - MIXED GAME (Hold'em/Omaha)
 */

import { useParams, useNavigate } from 'react-router-dom';
import './CreateTablePage.css';

const gameTypeCardAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(10px)',
  animation: `animationsFadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

interface GameType {
  id: string;
  name: string;
  subtitle: string;
  gradient: string;
  icon: string;
  unlockLevel: number;
}

// FIX 116: 9 approved variants only — removed flh, plo, flo, mixed
const GAME_TYPES: GameType[] = [
  {
    id: 'nlh',
    name: 'NLH',
    subtitle: "NO LIMIT HOLD'EM",
    gradient: 'linear-gradient(135deg, #1877F2 0%, #166FE5 50%, #0d5bbd 100%)',
    icon: '♠',
    unlockLevel: 1,
  },
  {
    id: 'plo4',
    name: 'PLO4',
    subtitle: 'POT LIMIT OMAHA 4',
    gradient: 'linear-gradient(135deg, #2374E1 0%, #1963c6 50%, #1252a8 100%)',
    icon: '♥',
    unlockLevel: 1,
  },
  {
    id: 'plo5',
    name: 'PLO5',
    subtitle: 'POT LIMIT OMAHA 5',
    gradient: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 50%, #1d4ed8 100%)',
    icon: '♦',
    unlockLevel: 1,
  },
  {
    id: 'plo6',
    name: 'PLO6',
    subtitle: 'POT LIMIT OMAHA 6',
    gradient: 'linear-gradient(135deg, #4299e1 0%, #3182ce 50%, #2b6cb0 100%)',
    icon: '♣',
    unlockLevel: 1,
  },
  {
    id: 'plo8',
    name: 'PLO8',
    subtitle: 'OMAHA HI-LO',
    gradient: 'linear-gradient(135deg, #1a73e8 0%, #1557b0 50%, #0d3d7a 100%)',
    icon: '♠',
    unlockLevel: 1,
  },
  {
    id: 'pineapple',
    name: 'PINE',
    subtitle: 'PINEAPPLE',
    gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 50%, #b45309 100%)',
    icon: '♥',
    unlockLevel: 1,
  },
  {
    id: 'short_deck',
    name: '6+',
    subtitle: "SHORT DECK HOLD'EM",
    gradient: 'linear-gradient(135deg, #0866FF 0%, #0557d6 50%, #0449b0 100%)',
    icon: '♦',
    unlockLevel: 1,
  },
  // ── LIMIT (2026-08-23, Dan) ───────────────────────────────────────────────
  // The lobby has always had a LIMIT tab, and ClubHomePage.cashKind() has
  // always sorted `flh`/`limit_*` tables into it — but FIX 116 deleted the only
  // two cards that could produce such a table, so the tab was structurally
  // empty and this screen offered no way to fill it.
  //
  // Both games are now played fixed-limit for real (see
  // server/src/engine/BettingStructure.ts) rather than dealt as limit and bet
  // as no-limit, which is what a bare card restore would have produced.
  //
  // Green on purpose: at a glance a player should be able to tell a limit table
  // from the blue no-limit and pot-limit ones BEFORE they sit down, because the
  // betting rules they are agreeing to are completely different.
  {
    id: 'flh',
    name: 'FLH',
    subtitle: "FIXED LIMIT HOLD'EM",
    gradient: 'linear-gradient(135deg, #10b981 0%, #059669 50%, #047857 100%)',
    icon: '♠',
    unlockLevel: 1,
  },
  {
    id: 'flo8',
    name: 'FLO8',
    subtitle: 'FIXED LIMIT OMAHA HI-LO',
    gradient: 'linear-gradient(135deg, #14b8a6 0%, #0d9488 50%, #0f766e 100%)',
    icon: '♣',
    unlockLevel: 1,
  },
];

/** Every variant this selector can hand to the config form, by route id. */
export const CREATE_TABLE_GAME_TYPE_IDS: readonly string[] = GAME_TYPES.map((g) => g.id);

export function isCreateTableGameType(value: string | null | undefined): value is string {
  return !!value && CREATE_TABLE_GAME_TYPE_IDS.includes(value);
}

export default function CreateTablePage({
  clubIdOverride,
  onBack,
  onSelectGameType,
}: {
  clubIdOverride?: string;
  onBack?: () => void;
  /**
   * EMBEDDED MODE (2026-09-04). Table Management renders this selector inside
   * its own page, for a club or for a union. Before this, picking a variant
   * navigated to /clubs/<host>/create-table/<variant> - which, from the union
   * console, threw the operator out of the union entirely and onto a member
   * club's page (Dan hit exactly that: Midway Union -> Club JAQK). When the
   * host supplies this callback the selection stays on the host's page and
   * the host decides what to render next.
   */
  onSelectGameType?: (gameTypeId: string) => void;
} = {}) {
  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const clubId = clubIdOverride || routeClubId;
  const navigate = useNavigate();
  const userLevel = 1; // All game types unlocked at level 1

  // Access is enforced by GameCreationGuard. For a union-managed club that
  // means only an authorized union operator reaches this selector.

  const handleSelectGameType = (gameType: GameType) => {
    if (userLevel < gameType.unlockLevel) {
      // Show unlock message
      return;
    }
    if (onSelectGameType) {
      onSelectGameType(gameType.id);
      return;
    }
    // Navigate to table configuration with selected game type
    navigate(`/clubs/${clubId}/create-table/${gameType.id}`);
  };

  const handleBack = () => {
    if (onBack) onBack();
    else navigate(`/clubs/${clubId}`);
  };

  return (
    <div className="create-table-page">
      {/* Back Button */}
      <button className="create-table-page__back" onClick={handleBack}>
        ‹‹
      </button>

      {/* Game Type List */}
      <div className="create-table-page__list">
        {GAME_TYPES.map((gameType, index) => (
          <button
            key={gameType.id}
            className={`game-type-card ${userLevel < gameType.unlockLevel ? 'locked' : ''}`}
            style={{
              background: gameType.gradient,
              ...gameTypeCardAnimationStyle(index),
            }}
            onClick={() => handleSelectGameType(gameType)}
            disabled={userLevel < gameType.unlockLevel}
          >
            <div className="game-type-card__create-badge">CREATE»</div>
            <div className="game-type-card__content">
              <h2 className="game-type-card__name">{gameType.name}</h2>
              <p className="game-type-card__subtitle">{gameType.subtitle}</p>
            </div>
            <div className="game-type-card__icon">
              {/* Decorative icon area - would use actual game graphics */}
            </div>
          </button>
        ))}
      </div>

      {/* The "Table Template" footer button was removed 2026-08-27: it had no
          onClick since the page was written — a button that does nothing.
          Templates live on the config page itself (the Load Template dropdown
          and Save as Template button), which is where a template is useful. */}

      {/* Background */}
      <div className="create-table-page__background"></div>
    </div>
  );
}
