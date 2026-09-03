import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const sources = sourceFiles(SRC);

describe('managed game lifecycle has one browser authority', () => {
  it('no browser source soft-deletes a table directly', () => {
    const offenders = sources.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return (
        /\.from\(['"]tables['"]\)[\s\S]{0,500}\.update\([\s\S]{0,220}is_deleted:\s*true/.test(
          source
        ) ||
        /\.from\(['"]tables['"]\)[\s\S]{0,500}\.update\([\s\S]{0,220}status:\s*['"]deleted['"]/.test(
          source
        )
      );
    });
    expect(offenders.map((path) => path.replace(`${ROOT}/`, ''))).toEqual([]);
  });

  it('no browser source cancels a tournament directly', () => {
    const offenders = sources.filter((path) =>
      /\.from\(['"]tournaments['"]\)[\s\S]{0,500}\.update\([\s\S]{0,220}status:\s*['"]CANCEL(?:L)?ED['"]/.test(
        readFileSync(path, 'utf8')
      )
    );
    expect(offenders.map((path) => path.replace(`${ROOT}/`, ''))).toEqual([]);
  });

  it('both legacy club pages invoke the managed close command', () => {
    for (const page of ['src/pages/ClubDetailPage.tsx', 'src/pages/ClubHomePage.tsx']) {
      const source = readFileSync(join(ROOT, page), 'utf8');
      expect(source).toContain("gameManagementService.close('table', id)");
      expect(source).toContain('It can only close after every player has left.');
    }
  });

  it('the old tournament service cannot reach the refund cancellation RPC', () => {
    const service = readFileSync(join(ROOT, 'src/services/TournamentService.ts'), 'utf8');
    expect(service).not.toContain("supabase.rpc('atomic_cancel_tournament'");
    expect(service).toContain("gameManagementService.close('tournament', tournamentId)");
  });

  it('legacy table controls cannot force-close or fake pause state in the database', () => {
    const service = readFileSync(join(ROOT, 'src/services/TableService.ts'), 'utf8');
    expect(service).not.toContain("supabase.rpc('fn_admin_close_table'");
    expect(service).toContain("gameManagementService.close('table', tableId)");
    expect(service).toContain('gameManagementService.pause(tableId)');
    expect(service).toContain('gameManagementService.resume(tableId)');

    const pauseStart = service.indexOf('async pauseTable(');
    const deleteStart = service.indexOf('async deleteTable(', pauseStart);
    const pauseResumeBlock = service.slice(pauseStart, deleteStart);
    expect(pauseResumeBlock).not.toContain(".from('tables')");
  });

  /**
   * Found on 2026-09-01 auditing the shipped phases against the live database.
   *
   * fn_admin_close_table is SECURITY DEFINER and was still EXECUTE-granted to
   * `authenticated`. It does not trip trg_tables_managed_lifecycle_guard
   * because it empties the table first: it credits every seated stack back,
   * sets left_at on every seat, and only then closes. By the time the guard
   * looks, no seat has a null left_at.
   *
   * The frontend stopped calling it in Phase 1, but the point of Phase 1 was
   * that the rule must not depend on the frontend. Any club admin could still
   * call it directly and cash out a live table mid-hand, horses and humans
   * alike. Revoked to match what the same phase did to its tournament twin,
   * atomic_cancel_tournament.
   */
  it('the legacy force-close RPC is out of reach of an ordinary authenticated caller', () => {
    const migration = readFileSync(
      join(ROOT, 'supabase/migrations/20260902223000_the_last_door_that_could_evict_a_player.sql'),
      'utf8'
    );
    expect(migration).toContain(
      'REVOKE EXECUTE ON FUNCTION public.fn_admin_close_table(uuid) FROM authenticated;'
    );
    expect(migration).toContain(
      'REVOKE EXECUTE ON FUNCTION public.fn_admin_close_table(uuid) FROM anon;'
    );
  });

  it('the legacy operations dialog states that occupied tables are never force-closed', () => {
    const panel = readFileSync(join(ROOT, 'src/components/club/TableOperationsPanel.tsx'), 'utf8');
    expect(panel).toContain('It Can Only Close After Every Player Has Left');
    expect(panel).toContain('Players Will Never Be Removed Or Cashed Out');
    expect(panel).not.toContain('all seated players refunded');
  });
});
