import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = readFileSync(path.resolve(__dirname, '../../src/main.tsx'), 'utf8');

describe('activation telemetry never blocks the first paint', () => {
  it('loads the funnel tracker dynamically instead of in the entry graph', () => {
    expect(main).not.toContain("import { startFunnelTracker } from './lib/funnelTracker'");
    expect(main).toContain("import('./lib/funnelTracker')");
  });

  it('recovers stale tracker chunks before reporting a non-blocking error', () => {
    expect(main).toContain(
      ".catch((err) => handleBootImportError(err, 'main.FunnelTracker_init_error_non_blocking'))"
    );
    expect(main).toContain('void recoverFromStaleChunk(error).then((recovering) => {');
    expect(main).toContain('if (!recovering) reportError(error, context);');
  });
});

describe('membership warming starts without entering the critical graph', () => {
  it('dynamically loads ClubsService only for a local session', () => {
    expect(main).not.toContain("import { warmUserMemberships } from './services/ClubsService'");
    expect(main).toContain('if (hasLocalSession())');
    expect(main).toContain("import('./services/ClubsService')");
  });

  it('recovers stale membership chunks before reporting a non-blocking error', () => {
    expect(main).toContain(
      ".catch((err) => handleBootImportError(err, 'main.Membership_warm_start_non_blocking'))"
    );
    expect(main).toContain('void recoverFromStaleChunk(error).then((recovering) => {');
    expect(main).toContain('if (!recovering) reportError(error, context);');
  });
});
