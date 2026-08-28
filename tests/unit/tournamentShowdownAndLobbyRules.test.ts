/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DAN'S 2026-08-28 RULES: TOURNAMENT SHOWDOWNS, AND A LOBBY THAT CANNOT LIE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. "IN SPINS, ITS A TOURNAMENT, SO THE 'SHOW CARDS' POP UP SHOULD NEVER EVER
 *    APPEAR, ALL CARDS ARE ALWAYS SHOWN AT SHOWDOWN."
 *
 *    Two halves, pinned separately because they live in different processes.
 *    The POPUP is client-side: TablePage decides whether to open HandReveal
 *    and TableModalsLayer decides whether to render it — both now refuse on a
 *    tournament, so neither a re-armed flag nor some future opener can put it
 *    on a Spin. The SHOWDOWN is server-side: applyShowdownRevealRules lets a
 *    hand that cannot win or tie any pot stay face-down, which is the cash
 *    courtesy and is wrong for a tournament, so the whole muck branch is
 *    skipped when the hand is played in one.
 *
 * 2. "REMOVE ANY HOVER EFFECT FROM THE SPINS LOBBY."
 *
 * 3. A saved filter must never leave the lobby looking empty while the club is
 *    running games — the state that produced "every single one disappears
 *    from the spins lobby".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod } from '../helpers/sourceWindow';

const readSrc = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');
const readServer = (p: string) => readFileSync(resolve(__dirname, '../../server/src', p), 'utf8');

describe('the show-cards prompt never appears in a tournament', () => {
  it('TablePage refuses to open it on a tournament table', () => {
    const table = readSrc('pages/TablePage.tsx');
    const i = table.indexOf('ASK_TO_SHOW_ON_UNCONTESTED_WIN &&');
    expect(i, 'the uncontested-win prompt gate has moved').toBeGreaterThan(-1);
    // The tournament refusal must be part of the same condition, not a
    // separate statement somebody can reorder away from it.
    const condition = table.slice(i, table.indexOf(') {', i));
    expect(condition).toContain('!tableStateRef.current.isTournament');
  });

  it('TableModalsLayer refuses to render it on a tournament table', () => {
    const layer = readSrc('components/table/TableModalsLayer.tsx');
    expect(layer).toContain('{showHandRevealModal && tableId && !isTournament && (');
  });
});

describe('a tournament showdown is always face up', () => {
  const hc = readServer('engine/HandController.ts');

  it('the muck rules are skipped entirely for a tournament hand', () => {
    const body = sliceMethod(
      hc,
      'private applyShowdownRevealRules(results: ShowdownResult[], pots: Pot[]): void {'
    );
    expect(body).toContain('if (this.config.isTournament) return;');
    /* Before the all-in lock, so the two early returns read as one rule set
       and neither can be reached only after a muck has been assigned. */
    expect(body.indexOf('if (this.config.isTournament) return;')).toBeLessThan(
      body.indexOf('if (this.allInShowdownLocked) return;')
    );
  });

  it('the engine actually tells the hand it is a tournament', () => {
    const dealing = readServer('engine/ServerTableEngineDealing.ts');
    expect(dealing).toContain('isTournament: this.isTournamentTable(),');
    expect(readServer('types.ts')).toContain('isTournament?: boolean;');
  });
});

describe('the lobby has no hover effects', () => {
  const css = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.css'), 'utf8');
  it('no rule in the lobby table stylesheet targets :hover', () => {
    // Comments mentioning the removed rules are fine; a selector is not.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hoverSelectors = withoutComments.match(/[^\n{}]*:hover[^\n{}]*\{/g) || [];
    expect(hoverSelectors).toEqual([]);
  });
});

describe('a saved filter cannot leave the lobby empty', () => {
  it('ClubHomePage clears filters that hide every game and says so', () => {
    const club = readSrc('pages/ClubHomePage.tsx');
    expect(club).toContain('autoUnfilteredRef');
    expect(club).toContain('Filters Cleared, They Were Hiding Every Game');
    // It must only fire when the FILTERS are what emptied it, and only while
    // the club genuinely has games — never on a quiet club.
    expect(club).toContain('if (!narrowing.filtered || !narrowing.fSpec) return;');
    expect(club).toContain('if (tables.length + tournaments.length <= 0) return;');
  });
});

describe('the browser never seats horses', () => {
  it('seedTable refuses on every table, cash included', () => {
    const hydra = readSrc('services/HydraService.ts');
    const body = sliceMethod(hydra, 'async seedTable(');
    expect(body).toContain('HydraService.seedTable_refused_client_seating');
    // The write path is gone, not merely guarded.
    expect(body).not.toContain('seatHorse(');
  });

  it('TablePage no longer runs a client horse loader', () => {
    const table = readSrc('pages/TablePage.tsx');
    /* The CALL, not the name — the note recording the removal names
       `HydraService.seedTable` in prose, and matching that would compare a
       comment against code (the same trap the source-window helper exists
       for). */
    expect(table).not.toContain('HydraService.seedTable(');
    expect(table).not.toContain('populateHorsePlayers');
  });
});

describe('the spin frequency denominator is derived, not typed', () => {
  it('both copies sum the ladder instead of hard-coding a total', () => {
    for (const p of ['../../src/config/spinSpec.ts', '../../server/src/config/spinSpec.ts']) {
      const spec = readFileSync(resolve(__dirname, p), 'utf8');
      expect(spec).toContain(
        'export const SPIN_FREQ_DENOMINATOR: number = SPIN_TIERS.reduce((sum, t) => sum + t.freq, 0);'
      );
      expect(spec).not.toContain('SPIN_FREQ_DENOMINATOR = 10_000_000');
    }
  });
});

describe('the round countdown belongs to a game that is running', () => {
  /* Found by the hostile-state pass: opening a COMPLETED spin through an old
     bookmark drew "Round Ends In 0:00" over a game that had ended. It was
     always wrong — `levelHasStarted` is true for a finished game, which has a
     started_at — and promoting the clock to its own masthead line is what
     made it visible. Both the mount read and the live status change now drop
     the clock when the game is over. */
  const table = readSrc('pages/TablePage.tsx');
  it('the mount read refuses to start a clock on a finished game', () => {
    expect(table).toContain('const gameIsOver =');
    expect(table).toContain('if (durSec > 0 && levelHasStarted && !gameIsOver) {');
  });
  it('a game ending live clears the clock instead of freezing it at 0:00', () => {
    expect(table).toContain("['COMPLETED', 'CANCELLED', 'FINISHED'].includes(status)");
    expect(table).toContain('setLevelClock(null);');
  });
});
