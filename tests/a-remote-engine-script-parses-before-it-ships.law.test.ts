/**
 * ===========================================================================
 *  LAW - A REMOTE ENGINE SCRIPT PARSES BEFORE IT SHIPS
 * ===========================================================================
 *
 * 2026-10-17, the owner-authorised DA10 rollback drill (run 39050314819). Its
 * rollback to 68f452ce sealed at the 12:55 break, and the next step - the
 * independent identity proof that has to pass before the drill rolls FORWARD
 * - died with `bash: line 18: syntax error near unexpected token '('`.
 * Production was left on the rolled-back engine, which did not carry the
 * boot-read fix of #7290, and the next break paged ClubArenaEngineKillStorm:
 * 104 kills on 55 tables.
 *
 * The cause was one apostrophe. The proof sends a script to the engine host as
 * a quoted heredoc (`bash -se <<'REMOTE'`), and inside it a Python program is
 * passed as `python3 -c '...'`. A comment in that program read "The engine's
 * own leadership witness": the apostrophe closed the single-quoted program on
 * the remote shell, and the next `(` was shell syntax. Nothing parsed the
 * remote script before it ran on production, so nothing could catch it.
 *
 * #7304 fixed the comment and pinned the drill workflow's own scripts
 * (rollback-drills-ride-the-release-lane.law). The same transport - a
 * quoted <<'REMOTE' heredoc carrying python3 -c '...' - is how the RELEASE
 * lane (auto-deploy-hetzner) and the crash drill (engine-drill) reach the
 * engine host, and a stray quote there would strand a release the same way.
 * This parses every remote heredoc in every workflow with `bash -n`, the way
 * the engine host will read it, so a script that cannot even be read fails
 * here instead of in the middle of a release or a drill.
 *
 * Registry: docs/laws.d/a-remote-engine-script-parses-before-it-ships.md
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOWS = resolve(process.cwd(), '.github/workflows');

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

/** Every `<<'TAG'` / `<<"TAG"` / `<<TAG` heredoc body in a run script. */
function heredocs(run: string): Array<{ tag: string; body: string }> {
  const lines = run.split('\n');
  const found: Array<{ tag: string; body: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /<<-?\s*(['"]?)([A-Z][A-Z0-9_]*)\1\s*$/.exec(lines[i]);
    if (!open) continue;
    const tag = open[2];
    const end = lines.findIndex((l, j) => j > i && l.trim() === tag);
    if (end === -1) continue;
    found.push({ tag, body: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return found;
}

function remoteScripts(): Array<{ where: string; body: string }> {
  const out: Array<{ where: string; body: string }> = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow;
    for (const [job, def] of Object.entries(wf?.jobs ?? {})) {
      for (const step of def?.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        for (const doc of heredocs(step.run)) {
          if (doc.tag !== 'REMOTE') continue;
          out.push({
            where: `${file} > ${job} > ${step.name ?? '(unnamed)'} <<${doc.tag}`,
            body: doc.body,
          });
        }
      }
    }
  }
  return out;
}

function bashParses(body: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'remote-heredoc-'));
  const path = join(dir, 'remote.sh');
  try {
    writeFileSync(path, body);
    execFileSync('bash', ['-n', path], { stdio: 'pipe' });
    return null;
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a remote engine script parses before it ships', () => {
  const scripts = remoteScripts();

  it('finds the remote scripts the release and drill lanes send to the engine host', () => {
    const files = new Set(scripts.map((s) => s.where.split(' > ')[0]));
    expect(files).toEqual(
      new Set([
        'auto-deploy-hetzner.yml',
        'engine-drill.yml',
        'engine-rollback-drill.yml',
        'publish-club-arena.yml',
      ])
    );
  });

  it.each(remoteScripts().map((s) => [s.where, s.body] as const))('%s parses', (_where, body) => {
    expect(bashParses(body)).toBeNull();
  });

  it('would have caught the 2026-10-17 drill: an apostrophe inside python3 -c', () => {
    const broken = [
      'set -euo pipefail',
      'OUT="$(python3 -c \'',
      "# The engine's own leadership witness",
      'ok=d.get("role")=="leader"',
      '\')"',
    ].join('\n');
    expect(bashParses(broken)).toMatch(/syntax error|unexpected/);
  });
});
