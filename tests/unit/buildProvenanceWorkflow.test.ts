import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
};
type Workflow = {
  jobs?: Record<
    string,
    {
      defaults?: { run?: { 'working-directory'?: string } };
      steps?: Step[];
    }
  >;
};

function stampsProvenance(
  command: string,
  scripts: Record<string, string>,
  seen = new Set<string>()
): boolean {
  if (command.includes('scripts/stamp-build-provenance.mjs')) return true;
  for (const match of command.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)) {
    const name = match[1];
    if (seen.has(name) || !scripts[name]) continue;
    seen.add(name);
    if (stampsProvenance(scripts[name], scripts, seen)) return true;
  }
  return false;
}

describe('GitHub build provenance callers', () => {
  it('fetches full ancestry before every build that stamps provenance, including nested npm scripts', () => {
    const directory = path.resolve('.github/workflows');
    const builds: string[] = [];
    const incomplete: string[] = [];
    for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = parse(readFileSync(path.join(directory, file), 'utf8')) as Workflow;
      for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = job.steps ?? [];
        for (const [index, step] of steps.entries()) {
          if (!step.run) continue;
          const cwd = step['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? '.';
          // Commands without npm scripts or a direct stamp cannot reach this build chain.
          if (!/\bnpm\s+run\b|scripts\/stamp-build-provenance\.mjs/.test(step.run)) continue;
          const manifest = JSON.parse(readFileSync(path.resolve(cwd, 'package.json'), 'utf8')) as {
            scripts: Record<string, string>;
          };
          if (!stampsProvenance(step.run, manifest.scripts)) continue;
          const label = `${file}:${name}`;
          builds.push(label);
          const checkout = steps
            .slice(0, index)
            .reverse()
            .find((prior) => /^actions\/checkout@/.test(prior.uses ?? ''));
          if (checkout?.with?.['fetch-depth'] !== 0) incomplete.push(label);
        }
      }
    }
    expect(builds).toContain('publish-club-arena.yml:build-and-store');
    expect(builds.length).toBeGreaterThanOrEqual(4);
    expect(
      incomplete,
      'Strict provenance needs full history in every actual web/native build caller'
    ).toEqual([]);
  });
});
