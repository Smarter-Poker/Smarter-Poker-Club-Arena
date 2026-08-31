import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, '../src/pages/PlayerStatsPage.tsx'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../src/pages/PlayerStatsPage.css'), 'utf8');
const POST_DEPLOY_WORKFLOW = readFileSync(
  resolve(__dirname, '../.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);

describe('Stats operational transparency', () => {
  it('measures the authenticated RPC without recording player identity', () => {
    expect(PAGE).toContain("capture('stats_rpc_load'");
    expect(PAGE).toContain('duration_ms');
    expect(PAGE).toContain('payload_bytes');
    expect(PAGE).not.toMatch(/capture\('stats_rpc_load',[\s\S]{0,400}(?:user_id|targetUserId)/);
  });

  it('shows when the readout was loaded and whether it came from cache', () => {
    expect(PAGE).toContain('stats-last-updated');
    expect(PAGE).toContain('lastUpdatedAt');
    expect(PAGE).toContain('statsDataSource');
  });
});

describe('Stats mobile fold budget', () => {
  it('keeps the phone hero compact and turns the evidence cards into a snap rail', () => {
    const phone = CSS.slice(CSS.lastIndexOf('@media (max-width: 390px)'));
    expect(phone).toMatch(/\.stats-command-deck\s*\{[\s\S]{0,180}min-height:\s*(?:[1-4]\d{2})px/);
    expect(phone).toMatch(/\.stats-brief-grid\s*\{[\s\S]{0,220}grid-auto-flow:\s*column/);
    expect(phone).toMatch(/scroll-snap-type:\s*x mandatory/);
    expect(phone).not.toMatch(
      /\.stats-brief-actions\s*\{[\s\S]{0,100}grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
  });
});

describe('Stats evidence links to real hand history', () => {
  it('never sends a hand-history action to the member sessions page', () => {
    expect(PAGE).not.toContain("navigate('/player-sessions')");
    expect(PAGE).toContain('navigate(`/hand-history?');
    expect(PAGE).toContain('openHandEvidence');
  });
});

describe('Stats production certification', () => {
  it('runs the deep, mobile, and accessibility suite after every successful deploy', () => {
    const statsGate = POST_DEPLOY_WORKFLOW.indexOf('tests/e2e/stats-deep.spec.ts');
    const broadSweep = POST_DEPLOY_WORKFLOW.indexOf('tests/e2e/smoke.spec.ts');
    expect(statsGate).toBeGreaterThan(-1);
    expect(broadSweep).toBeGreaterThan(statsGate);
    expect(POST_DEPLOY_WORKFLOW.match(/tests\/e2e\/stats-deep\.spec\.ts/g)).toHaveLength(1);
  });
});
