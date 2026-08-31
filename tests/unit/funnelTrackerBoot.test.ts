import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = readFileSync(path.resolve(__dirname, '../../src/main.tsx'), 'utf8');

describe('activation telemetry never blocks the first paint', () => {
  it('loads the funnel tracker dynamically instead of in the entry graph', () => {
    expect(main).not.toContain("import { startFunnelTracker } from './lib/funnelTracker'");
    expect(main).toContain("import('./lib/funnelTracker')");
  });

  it('keeps lazy-load and tracker failures on the non-blocking error path', () => {
    expect(main).toContain(
      ".catch((err) => reportError(err, 'main.FunnelTracker_init_error_non_blocking'))"
    );
  });
});
