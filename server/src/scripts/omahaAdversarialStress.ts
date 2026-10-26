import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This command is an isolated simulator. Never inherit database credentials.
process.env.EQUITY_GOVERNOR = 'off';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-stress-placeholder';

async function main() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(variant|opponent|hands|seed|seats|stack|out)=(.+)$/.exec(arg);
    if (!match || args.has(match[1])) throw Error('Unknown or duplicate stress argument');
    args.set(match[1], match[2]);
  }
  if (!args.has('variant') || !args.has('opponent') || !args.has('seed'))
    throw Error(
      'Required: --variant=plo4|plo5|plo6 --opponent=caller|folder|raiser|passive_value --seed=INTEGER'
    );
  const { runOmahaAdversarialStress, validateOmahaStressRequest } =
    await import('../benchmark/OmahaAdversarialStress.js');
  const request = {
    variant: args.get('variant')!,
    opponent: args.get('opponent')!,
    seed: Number(args.get('seed')),
    hands: Number(args.get('hands') ?? 12),
    seats: Number(args.get('seats') ?? 6),
    stackBB: Number(args.get('stack') ?? 100),
  } as Parameters<typeof runOmahaAdversarialStress>[0];
  validateOmahaStressRequest(request);
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  const digest = createHash('sha256');
  async function source(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) await source(full);
      else if (entry.isFile() && /\.(ts|json)$/.test(entry.name)) {
        digest.update(full.slice(sourceRoot.length));
        digest.update('\0');
        digest.update(await readFile(full));
        digest.update('\0');
      }
    }
  }
  await source(resolve(sourceRoot, 'src'));
  digest.update(await readFile(resolve(sourceRoot, 'package-lock.json')));
  const sourceSha256 = digest.digest('hex');
  const result = await runOmahaAdversarialStress(request);
  const text = JSON.stringify({ ...result, sourceSha256 }, null, 2) + '\n';
  if (args.has('out')) await writeFile(resolve(args.get('out')!), text, { flag: 'wx' });
  process.stdout.write(text);
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Stress execution failed'}\n`);
  process.exit(1);
}
