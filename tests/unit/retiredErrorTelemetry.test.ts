import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const provider = ['sen', 'try'].join('');
const capitalizedProvider = provider[0].toUpperCase() + provider.slice(1);
const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), 'utf8');
function files(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = directory + '/' + entry.name;
    if (entry.isDirectory()) return files(file);
    return /\.(?:ts|tsx|js|mjs|cjs|yml|yaml)$/.test(file) ? [file] : [];
  });
}

describe('retired external error telemetry stays absent', () => {
  it('has no SDK packages in client or engine dependency graphs', () => {
    for (const file of [
      'package.json',
      'package-lock.json',
      'server/package.json',
      'server/package-lock.json',
    ]) {
      expect(read(file), file).not.toMatch(new RegExp(`@${provider}(?:-internal)?/`, 'i'));
    }
  });
  it('has no runtime imports, ingest endpoints, or activation environment variables', () => {
    const candidates = [
      ...files('src'),
      ...files('server/src'),
      ...files('.github/workflows'),
      'vite.config.ts',
    ];
    for (const file of candidates.filter((file) => !/\.(?:test|spec)\./.test(file))) {
      const source = read(file);
      expect(source, file).not.toMatch(
        new RegExp(
          String.raw`(?:from\s*|import\s*\(?\s*)['"][^'"]*(?:@${provider}|${provider}Init|${provider}Bundle)`,
          'i'
        )
      );
      expect(source, file).not.toMatch(new RegExp(String.raw`${provider}\.io`, 'i'));
      expect(source, file).not.toMatch(
        new RegExp(
          String.raw`(?:process\.env|import\.meta\.env)\.(?:VITE_|CA_)?${provider.toUpperCase()}_`
        )
      );
      expect(source, file).not.toMatch(
        new RegExp(String.raw`^\s*(?:VITE_|CA_)?${provider.toUpperCase()}_\w+:`, 'm')
      );
    }
  });
  it('removes transport and upload modules rather than retaining dormant toggles', () => {
    for (const file of [
      `src/core/${capitalizedProvider}Init.ts`,
      `src/core/${provider}Bundle.ts`,
      `scripts/${provider}-upload-policy.ts`,
      `server/src/services/${provider}EventBudget.ts`,
    ]) {
      expect(existsSync(join(root, file)), file).toBe(false);
    }
  });
});
