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

  it('the legacy operations dialog states that occupied tables are never force-closed', () => {
    const panel = readFileSync(join(ROOT, 'src/components/club/TableOperationsPanel.tsx'), 'utf8');
    expect(panel).toContain('It Can Only Close After Every Player Has Left');
    expect(panel).toContain('Players Will Never Be Removed Or Cashed Out');
    expect(panel).not.toContain('all seated players refunded');
  });
});
