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
import ArenaGameCard from '../components/lobby/game-cards/ArenaGameCard';
import type { ArenaGameFamily } from '../components/lobby/game-cards/arenaGameCardTypes';
import { SpadeConsole } from '../components/console/SpadeConsole';
import './CreateTablePage.css';

interface GameType {
  id: string;
  name: string;
  subtitle: string;
  unlockLevel: number;
}

// FIX 116: 9 approved variants only — removed flh, plo, flo, mixed
const GAME_TYPES: GameType[] = [
  {
    id: 'nlh',
    name: 'NLH',
    subtitle: "NO LIMIT HOLD'EM",
    unlockLevel: 1,
  },
  {
    id: 'plo4',
    name: 'PLO4',
    subtitle: 'POT LIMIT OMAHA 4',
    unlockLevel: 1,
  },
  {
    id: 'plo5',
    name: 'PLO5',
    subtitle: 'POT LIMIT OMAHA 5',
    unlockLevel: 1,
  },
  {
    id: 'plo6',
    name: 'PLO6',
    subtitle: 'POT LIMIT OMAHA 6',
    unlockLevel: 1,
  },
  {
    id: 'plo8',
    name: 'PLO8',
    subtitle: 'OMAHA HI-LO',
    unlockLevel: 1,
  },
  {
    id: 'pineapple',
    name: 'PINE',
    subtitle: 'PINEAPPLE',
    unlockLevel: 1,
  },
  {
    id: 'short_deck',
    name: '6+',
    subtitle: "SHORT DECK HOLD'EM",
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
    unlockLevel: 1,
  },
  {
    id: 'flo8',
    name: 'FLO8',
    subtitle: 'FIXED LIMIT OMAHA HI-LO',
    unlockLevel: 1,
  },
];

/** Every variant this selector can hand to the config form, by route id. */
export const CREATE_TABLE_GAME_TYPE_IDS: readonly string[] = GAME_TYPES.map((g) => g.id);

export function isCreateTableGameType(value: string | null | undefined): value is string {
  return !!value && CREATE_TABLE_GAME_TYPE_IDS.includes(value);
}

function familyForGameType(id: string): ArenaGameFamily {
  return id.startsWith('plo') || id === 'flo8' ? 'plo' : 'nlh';
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

  const selector = (
    <div className="create-table-page">
      {/* Back Button */}
      <button className="create-table-page__back" onClick={handleBack}>
        ‹‹
      </button>

      {/* Game Type List */}
      <div className="create-table-page__list">
        {GAME_TYPES.map((gameType) => (
          <ArenaGameCard
            key={gameType.id}
            className="create-table-page__game-card"
            data={{
              id: gameType.id,
              family: familyForGameType(gameType.id),
              title: gameType.name,
              subtitle: gameType.subtitle,
              gameType: gameType.name,
              stakes: 'Configure',
              players: '0',
              buyIn: 'Set Limits',
              status: userLevel < gameType.unlockLevel ? 'closed' : 'open',
              statusLabel: userLevel < gameType.unlockLevel ? 'Locked' : 'Ready',
              rules: [],
            }}
            actions={{
              primaryLabel: userLevel < gameType.unlockLevel ? 'Locked' : 'Configure',
              primaryDisabled: userLevel < gameType.unlockLevel,
              onPrimary: () => handleSelectGameType(gameType),
              showIcons: false,
            }}
          />
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

  if (onSelectGameType) return selector;

  return (
    <main className="create-table-page__standalone">
      <SpadeConsole
        eyebrow="Table Management"
        title="Choose Game Type"
        subtitle="Select A Variant To Configure"
        pill={`${GAME_TYPES.length} Games`}
        crest="club"
      >
        {selector}
      </SpadeConsole>
    </main>
  );
}
