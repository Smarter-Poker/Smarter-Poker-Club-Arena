import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enumToTitleCase, titleCase } from '../../src/utils/titleCase';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Club Arena Every-Word Capitalization Law', () => {
  it('capitalizes joining words instead of applying conventional minor-word exceptions', () => {
    expect(titleCase('create a club and invite a player')).toBe(
      'Create A Club And Invite A Player'
    );
    expect(titleCase('request to join the club')).toBe('Request To Join The Club');
  });

  it('keeps platform acronyms uppercase while capitalizing every surrounding word', () => {
    expect(titleCase('watch an nlh table or a plo5 tournament')).toBe(
      'Watch An NLH Table Or A PLO5 Tournament'
    );
    expect(enumToTitleCase('request_to_join')).toBe('Request To Join');
  });

  it('enforces static copy in attributes, render expressions, and component registries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'club-arena-title-case-'));
    temporaryDirectories.push(directory);
    const fixture = join(directory, 'EverySurface.tsx');
    writeFileSync(
      fixture,
      `
        const card = { description: 'player command status' };
        export function EverySurface({ ready }: { ready: boolean }) {
          return (
            <main
              aria-label="player command"
              aria-description={\`open \${ready ? 'live table' : 'loading table'} now\`}
              title={ready ? 'live roster' : 'loading roster'}
            >
              <input
                placeholder="search members"
                aria-label={\`\${count} lvl\${count === 1 ? '' : 's'} left\`}
              />
              <span>{ready ? 'all players ready' : 'loading players'}</span>
              <span>direct page copy</span>
              <code title="spring_spins_push">user@example.com</code>
            </main>
          );
        }
        void card;
      `,
      'utf8'
    );

    const gate = resolve('scripts/ci/check-title-case.mjs');
    const env = { ...process.env, TITLE_CASE_SOURCE_DIR: directory };
    const failed = spawnSync(process.execPath, [gate], { env, encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('[attribute aria-label] player command');
    expect(failed.stderr).toContain('[render expression] all players ready');
    expect(failed.stderr).toContain('[property description] player command status');

    execFileSync(process.execPath, [gate, '--fix'], { env });
    const fixed = readFileSync(fixture, 'utf8');
    expect(fixed).toContain('aria-label="Player Command"');
    expect(fixed).toContain("`Open ${ready ? 'Live Table' : 'Loading Table'} Now`");
    expect(fixed).toContain("ready ? 'All Players Ready' : 'Loading Players'");
    expect(fixed).toContain("description: 'Player Command Status'");
    expect(fixed).toContain("`${count} Lvl${count === 1 ? '' : 's'} Left`");
    expect(fixed).toContain('title="spring_spins_push"');
    expect(fixed).toContain('user@example.com');
  });
});
