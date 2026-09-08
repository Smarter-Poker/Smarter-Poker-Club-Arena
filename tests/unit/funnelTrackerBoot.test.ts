import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = readFileSync(path.resolve(__dirname, '../../src/main.tsx'), 'utf8');

describe('activation telemetry never blocks the first paint', () => {
  it('loads the funnel tracker dynamically instead of in the entry graph', () => {
    expect(main).not.toContain("import { startFunnelTracker } from './lib/funnelTracker'");
    expect(main).toContain("import('./lib/funnelTracker')");
    expect(main).toContain("importWithRetry(() => import('./lib/funnelTracker'))");
  });

  it('recovers stale tracker chunks before reporting a non-blocking error', () => {
    // 2026-09-07: tolerates Prettier's line break (see the membership pin below).
    expect(main).toMatch(
      /\.catch\(\(err\) =>\s*reportDeferredImportFailure\(err, 'main\.FunnelTracker_init_error_non_blocking'\)/
    );
    expect(main).toContain('installVitePreloadErrorRecovery();');
  });
});

describe('membership warming starts without entering the critical graph', () => {
  it('dynamically loads ClubsService only for a local session', () => {
    expect(main).not.toContain("import { warmUserMemberships } from './services/ClubsService'");
    expect(main).toContain('if (hasLocalSession())');
    expect(main).toContain("import('./services/ClubsService')");
    expect(main).toContain("importWithRetry(() => import('./services/ClubsService'))");
  });

  it('recovers stale membership chunks before reporting a non-blocking error', () => {
    // 2026-09-07: the boot sequence gained one level of nesting for the
    // native session restore, and Prettier now wraps this call across lines.
    // Same handler, same argument; the pin tolerates the line break.
    expect(main).toMatch(
      /\.catch\(\(err\) =>\s*reportDeferredImportFailure\(err, 'main\.Membership_warm_start_non_blocking'\)/
    );
    expect(main).toContain('installVitePreloadErrorRecovery();');
  });

  it('retries only recognized stale assets and keeps genuine code failures hard', () => {
    expect(main).toContain('if (isChunkLoadError(error))');
    expect(main).toContain('reportWarning(');
    expect(main).toContain('reportError(error, context)');
  });
});
