/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — A HORSE IS INDISTINGUISHABLE FROM A HUMAN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, binding:
 *
 *   "HUMAN USERS CAN NEVER KNOW THAT THIS IS A 'HORSE' AND NOT A 'HUMAN'.
 *    MAKE SURE THERE IS NO DIFFERENCE BETWEEN THAT AS ITS DISPLAYED."
 *
 * HOW THIS SITS WITH CLAUDE.md 10.5. They are the same policy pointed at two
 * different audiences, and the boundary is the AUDIENCE, not the mechanism:
 *
 *   - 10.5 forbids EXCLUDING horses from anything a human gets, and permits
 *     `is_horse` as identification DATA on staff surfaces (a badge, a column,
 *     a roster field, the fleet plumbing).
 *   - This law forbids REVEALING horse-ness to a player, on any surface a
 *     player can reach — rendered text, a DOM attribute, a React prop, or a
 *     column riding along in a query response.
 *
 * They do not conflict, and neither may be used to justify the other's
 * opposite. Do not "simplify" them into one rule.
 *
 * WHAT A PLAYER COULD SEE BEFORE THIS SHIPPED, all of it verified in source:
 *
 *   * `TableService.getSeatedPlayers` selected `is_horse` — one request, on
 *     every table open, labelling every seat.
 *   * The felt pulled `horse_id` on its `table_seats` reads and `is_horse` /
 *     `horse_profile` on three profile reads, then handed `isHorse` to
 *     `SeatSlot` as a prop, visible in React DevTools.
 *   * A 15-second poll asked `profiles?...&is_horse=eq.true` for the people at
 *     YOUR table, to pick one to retire — and the retirement had been a
 *     refusal since chip standard C1, so it leaked and achieved nothing.
 *   * The cashier roster printed a literal " (Horse)" beside a name, in
 *     English, to every agent and super agent.
 *   * Friend suggestions filtered `is_horse=eq.false`, putting the answer in
 *     the request URL and the absence in the result.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mapEngineSnapshot } from '../src/utils/mapEngineSnapshot';

const root = join(__dirname, '..');

/** Source with comments stripped: prose about a retired tell is not a tell. */
function code(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Surfaces an ordinary player can reach. Every one of these was leaking.
 * Adding a file here is how you extend the law; removing one needs a reason
 * in the PR body.
 */
const PLAYER_FACING = [
  'src/pages/TablePage.tsx',
  'src/services/TableService.ts',
  'src/services/FriendSuggestionService.ts',
  'src/pages/CashierTradePage.tsx',
  'src/components/table/SeatSlot.tsx',
  'src/components/wallet/PlayerWalletModal.tsx',
];

describe('LAW: no player-facing surface asks the database who is a horse', () => {
  for (const file of PLAYER_FACING) {
    it(`${file} does not read is_horse / horse_id / horse_profile`, () => {
      const source = code(file);
      for (const column of ['is_horse', 'horse_id', 'horse_profile', 'horse_status']) {
        expect(source, `${file} must not carry ${column} into a player's browser`).not.toContain(
          column
        );
      }
    });
  }
});

describe('LAW: no player-facing surface holds horse-ness in the component tree', () => {
  for (const file of PLAYER_FACING) {
    it(`${file} exposes no isHorse prop or field`, () => {
      /* React DevTools is one click. A prop nothing renders is still an
         answer, which is why the felt's `isHorse: ...` on the seat object had
         to go even though SeatSlot never branched on it. */
      expect(code(file)).not.toMatch(/\bisHorse\b/);
    });
  }
});

describe('LAW: no player-facing surface says the word', () => {
  for (const file of PLAYER_FACING) {
    it(`${file} renders no horse vocabulary`, () => {
      const source = code(file);
      // The literal that shipped in the cashier roster, and its neighbours.
      expect(source).not.toMatch(/\(Horse\)/);
      expect(source).not.toMatch(/'Horse Treasury Funding'/);
      expect(source).not.toMatch(/\[Horses\]/);
    });
  }
});

describe('LAW: the engine snapshot mapper drops horse-ness on the floor', () => {
  /* BEHAVIOURAL, not a text pin. `src/utils/mapEngineSnapshot.ts` is a pure,
     importable module, and `scripts/ci/report-source-grep-tests.mjs` ratchets
     against pinning those by regex — rightly: a regex passes on a line that is
     present and wrong. So this feeds the mapper a snapshot that DOES carry
     `is_horse` (as a hostile engine build might) and asserts that nothing
     horse-shaped survives onto the seat the felt renders. */
  const snapshotWithHorseFlag = {
    players: [
      {
        seat: 1,
        user_id: 'hero-1',
        username: 'Hero',
        stack: 1000,
        is_horse: false,
      },
      {
        seat: 2,
        user_id: 'other-1',
        username: 'Opponent',
        stack: 900,
        is_horse: true,
        horse_profile: 'maniac',
        horse_status: 'seated',
      },
    ],
  };

  it('never emits a horse flag onto a mapped seat', () => {
    const mapped = mapEngineSnapshot(snapshotWithHorseFlag as never, 'hero-1', 6) as unknown as {
      players: Array<Record<string, unknown> | null>;
    };

    const seats = (mapped.players || []).filter(Boolean) as Array<Record<string, unknown>>;
    expect(seats.length, 'the mapper should have produced seats to inspect').toBeGreaterThan(0);

    for (const seat of seats) {
      const serialised = JSON.stringify(seat);
      expect(serialised, 'a mapped seat must carry no horse signal').not.toMatch(/horse/i);
    }
  });
});

describe('LAW: the felt does not run fleet management', () => {
  const table = code('src/pages/TablePage.tsx');

  it('TablePage does not import HydraService', () => {
    /* Its seat WRITERS already refused; its READ helpers were the last thing
       telling a player's browser which opponents are horses. A browser cannot
       yield a horse's seat without first being told which players are horses,
       so this capability belongs in the engine and must not return here. */
    expect(table).not.toContain('HydraService');
  });

  it('TablePage runs no waitlist yield poll', () => {
    expect(table).not.toContain('checkWaitlistAndYield');
    expect(table).not.toContain('onRealPlayerJoined');
  });
});

describe('LAW: the horse machinery is not in the bundle a player downloads', () => {
  /* Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE
     OR USE A DEVELOPER TOOL AND FIND THIS OUT."
     Not asking the question is not enough if the ANSWER MACHINERY ships. One
     import of `ensureMidwayUnionSetup` pulled the whole 2,400-line orchestrator
     — every is_horse query, the fleet vocabulary, and a
     `window.ensureMidwayUnionSetup` global — into a player's union page, for a
     dead auto-create branch. `horseBugReporter` monkey-patched console.error on
     every client and POSTed to `horse_bug_reports`, putting the table and
     column names in the Network tab. */
  const HORSE_MODULES = ['HorseOrchestrator', 'HydraService', 'HorseBugReporter', 'HorseLogic'];

  function importers(moduleName: string): string[] {
    const roots = ['src/pages', 'src/components'];
    const found: string[] = [];
    const walk = (dir: string) => {
      const abs = join(root, dir);
      let entries: string[];
      try {
        entries = readdirSync(abs);
      } catch {
        return;
      }
      for (const name of entries) {
        const rel = `${dir}/${name}`;
        if (statSync(join(root, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name)) {
          // A real import statement, not a mention inside a comment.
          const source = code(rel);
          if (source.includes(`services/${moduleName}'`)) found.push(rel);
        }
      }
    };
    roots.forEach(walk);
    return found;
  }

  for (const moduleName of HORSE_MODULES) {
    it(`no page or component imports ${moduleName}`, () => {
      expect(
        importers(moduleName),
        `${moduleName} would be bundled into a player's download`
      ).toEqual([]);
    });
  }
});

describe('LAW: staff surfaces keep what 10.5 permits', () => {
  /* The other half of the boundary. These are gated behind staff/finance/admin
     capability guards, and 10.5 explicitly sanctions the flag as data there.
     This test exists so a later reader enforcing the player-facing rule does
     not "finish the job" by stripping the operator's roster too — that would
     be a different bug, and one nobody asked for. */
  it('the club dashboard still identifies horses for staff', () => {
    expect(code('src/pages/club/ClubDashboard.tsx')).toContain('isHorse');
  });

  it('the fleet services still identify horses', () => {
    expect(code('src/services/HydraService.ts')).toContain('is_horse');
  });
});
