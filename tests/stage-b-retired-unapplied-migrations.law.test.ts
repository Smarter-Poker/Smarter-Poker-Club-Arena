import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const activeDirectory = resolve(root, 'supabase/migrations');
const archiveDirectory = resolve(root, 'supabase/retired-unapplied');
const manifestPath = resolve(archiveDirectory, 'MANIFEST.sha256');
const thisLaw = resolve(__filename);

const retiredDigests = new Map([
  [
    '20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql',
    '27cf35a8b9cb3c7322265b755d0ec42f0d3feceb12dd4917e14589375b4c7036',
  ],
  [
    '20260909041438_retire_legacy_tournament_hold_refund_door.sql',
    '9c97c5cf0fd80f5585200c36c66d2ff277ba18e4b1a9cba9d17c6c14e3ec3b8d',
  ],
  [
    '20260909043000_tournament_terminal_roots_are_db_first_hardened.sql',
    'af23b09dd963122cf09072d8b240093b588d57cd91a272f7179c9efcc5b2e9bc',
  ],
  [
    '20260909182952_a_committed_tournament_move_receipt_survives_lease_loss.sql',
    'a64267e8a143fed0e2ddd363be70c97b096ba49667b06b1353c2822b7bc9846b',
  ],
  [
    '20260909222020_tournament_reseating_uses_one_database_chosen_legal_chair.sql',
    '1a48ec32d5e39324eda56a7a034b925989b25805328d74b1370b4bdc7ff15271',
  ],
  [
    '20260910000850_tournament_mutation_jobs_are_disabled_before_retirement.sql',
    'a074e811d7fd7718a1104ed8a9373624cbe88171bd59943e61ed96e07c848ce9',
  ],
  [
    '20260910000905_final_tournament_roster_seat_authority_after_scheduler_fence.sql',
    '908d9e9d415e43b697e4321a025bbf8d0330b0ab2d327c2a33165fd315269275',
  ],
  [
    '20260910002510_terminal_tournaments_cannot_reenter_a_break.sql',
    '63a8c419cd4359064676b2ba1cbd0a295b155a1fd8ae64af7494701ba2ffb4a8',
  ],
  [
    '20260910002520_precertify_stage_a_atomic_tournament_finishes.sql',
    '663dddd0c925530a2a96db88c6cd72fec04ce6abdda61813fda59b42f5b84335',
  ],
  [
    '20260910002530_tournament_manager_request_fencing_is_strict.sql',
    '2a2db816ef768a8258c5336f3d661efc443178956d4df56dd02f85b14fd3a045',
  ],
  [
    '20260910002540_hand_settlement_requires_exact_seat_generation.sql',
    '792f76e5198de3abddcc4b51f42a63184d259c3e0c8bec837be2bf5ca316f766',
  ],
  [
    '20260910002550_tournament_seat_moves_are_one_atomic_receipt.sql',
    '9284cdb5d4534bb57f299f7956dee85ae642c1ec9d0ddf1e0d16bc6dd3abceec',
  ],
  [
    '20260910002560_lease_heartbeats_do_not_starve_behind_live_transactions.sql',
    'bfa6bd884451186c0461ab67329957edc1cf33f2961870599a1c94322f43ac99',
  ],
] as const);
const retired = [...retiredDigests.keys()];

const manifestEntries = new Map(
  readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}([^/]+)$/.exec(line);
      if (!match) throw new Error(`invalid retired migration manifest row: ${line}`);
      return [match[2], match[1]] as const;
    })
);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const metadata = statSync(path);
    if (metadata.isDirectory()) {
      if (!['node_modules', 'dist', 'build', 'coverage'].includes(name)) {
        files.push(...sourceFiles(path));
      }
    } else if (
      ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh', '.py', '.sql', '.pending'].includes(
        extname(path)
      )
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('historical unapplied Stage-B migrations cannot re-enter the active chain', () => {
  it('keeps exactly thirteen byte-sealed audit artifacts outside active migrations', () => {
    expect([...manifestEntries.keys()].sort()).toEqual([...retired].sort());

    for (const file of retired) {
      const activePath = resolve(activeDirectory, file);
      const archivePath = resolve(archiveDirectory, file);
      expect(existsSync(activePath), `${file} must not be active`).toBe(false);
      expect(existsSync(archivePath), `${file} must remain archived`).toBe(true);
      const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
      expect(manifestEntries.get(file), `${file} manifest digest drifted`).toBe(
        retiredDigests.get(file)
      );
      expect(digest, `${file} archive bytes drifted`).toBe(retiredDigests.get(file));
    }
  });

  it('leaves no executable consumer resolving a retired filename or stable suffix', () => {
    const executableRoots = [
      resolve(root, 'tests'),
      resolve(root, 'server/src'),
      resolve(root, 'scripts'),
      activeDirectory,
    ];
    const forbidden = retired.flatMap((file) => [file, file.slice(15)]);
    const matches: string[] = [];

    for (const path of executableRoots.flatMap(sourceFiles)) {
      if (resolve(path) === thisLaw) continue;
      const source = readFileSync(path, 'utf8');
      // The composed forward SQL retains provenance comments naming the
      // byte-sealed sources it absorbed. Those comments cannot resolve or
      // execute an archived file; executable SQL references still fail.
      const executableSource = path.startsWith(`${activeDirectory}/`)
        ? source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
        : source;
      for (const token of forbidden) {
        if (executableSource.includes(token)) {
          matches.push(`${path.slice(root.length + 1)} -> ${token}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
