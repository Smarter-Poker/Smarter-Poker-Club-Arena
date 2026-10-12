/**
 * A stranger from the internet is not told how the seats divide between humans
 * and horses (launch audit 2026-10-05; Dan 2026-09-02: "NOBODY SHOULD EVER EVER
 * EVER BE ABLE TO ... USE A DEVELOPER TOOL AND FIND THIS OUT").
 *
 * /metrics and /stable-hand were public through Caddy with CORS `*`. A seated
 * player who reads `poker_humans_seated 1` knows every opponent is a horse.
 */
import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { arrivedThroughThePublicProxy, isSeatMixFamily, withoutSeatMix } from './publicStranger.js';
import { createRouter } from '../router.js';

const EXPOSITION = [
  '# HELP poker_active_tables Tables with a running engine',
  '# TYPE poker_active_tables gauge',
  'poker_active_tables 392',
  '# HELP poker_humans_seated Humans holding chips',
  '# TYPE poker_humans_seated gauge',
  'poker_humans_seated 1',
  '# HELP poker_horses_seated Horses holding chips',
  '# TYPE poker_horses_seated gauge',
  'poker_horses_seated 463',
  '# TYPE poker_tables_with_humans gauge',
  'poker_tables_with_humans 1',
  '# TYPE poker_tables_with_horses gauge',
  'poker_tables_with_horses 391',
  'poker_human_tables_ms_since_progress_max 1200',
  'poker_horses_seated_in_database{club="a"} 500',
  'poker_horses_in_decided_games 3',
  'poker_spin_human_unfilled_waits 0',
  'poker_stats_human_hands_without_facts 0',
  '# TYPE poker_horse_decision_worker_queue_depth gauge',
  'poker_horse_decision_worker_queue_depth{worker="0"} 2',
  'poker_ws_auth_refused_total{path="table",denied="invalid"} 4',
].join('\n');

describe('which requests are strangers', () => {
  it('a request Caddy forwarded carries X-Forwarded-For; an on-box scrape does not', () => {
    expect(arrivedThroughThePublicProxy({ headers: { 'x-forwarded-for': '203.0.113.9' } })).toBe(
      true
    );
    expect(arrivedThroughThePublicProxy({ headers: { 'x-forwarded-for': ['203.0.113.9'] } })).toBe(
      true
    );
    expect(arrivedThroughThePublicProxy({ headers: {} })).toBe(false);
  });
});

describe('the seat-mix families', () => {
  it.each([
    'poker_humans_seated',
    'poker_horses_seated',
    'poker_horses_seated_in_database',
    'poker_horses_in_decided_games',
    'poker_tables_with_humans',
    'poker_tables_with_horses',
    'poker_human_tables_ms_since_progress_max',
    'poker_spin_human_unfilled_waits',
    'poker_spin_human_oldest_wait_seconds',
    'poker_stats_human_hands_without_facts',
  ])('%s says who is seated', (name) => {
    expect(isSeatMixFamily(name)).toBe(true);
  });

  it.each([
    'poker_active_tables',
    'poker_horse_decision_worker_queue_depth',
    'poker_horse_turn_timeouts_total',
    'poker_ws_auth_refused_total',
    'poker_maintenance_break_active',
  ])('%s does not', (name) => {
    expect(isSeatMixFamily(name)).toBe(false);
  });

  it('are removed with their HELP and TYPE lines, and nothing else is', () => {
    const out = withoutSeatMix(EXPOSITION);
    expect(out).not.toMatch(/human/);
    expect(out).not.toMatch(/horses_seated|tables_with_horses|horses_in_decided_games/);
    expect(out.split('\n')).toEqual([
      '# HELP poker_active_tables Tables with a running engine',
      '# TYPE poker_active_tables gauge',
      'poker_active_tables 392',
      '# TYPE poker_horse_decision_worker_queue_depth gauge',
      'poker_horse_decision_worker_queue_depth{worker="0"} 2',
      'poker_ws_auth_refused_total{path="table",denied="invalid"} 4',
    ]);
  });
});

function capture() {
  const captured: { statusCode?: number; body: string } = { body: '' };
  const res = {
    writeHead: (code: number) => {
      captured.statusCode = code;
      return res;
    },
    setHeader: () => res,
    end: (chunk?: string) => {
      if (chunk) captured.body += chunk;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('the router applies it', () => {
  const router = createRouter({
    gameServer: { getPrometheusMetrics: () => EXPOSITION, getStatus: () => ({}) },
  } as never);
  const get = async (url: string, headers: Record<string, string>) => {
    const { res, captured } = capture();
    await router({ method: 'GET', url, headers } as unknown as IncomingMessage, res);
    return captured;
  };

  it('/metrics through the public proxy carries no seat mix', async () => {
    const out = await get('/metrics', { 'x-forwarded-for': '203.0.113.9' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('poker_active_tables 392');
    expect(out.body).not.toMatch(/poker_humans_seated|poker_horses_seated|tables_with_humans/);
  });

  it('/metrics scraped on the box is unchanged, so every alert still has its series', async () => {
    const out = await get('/metrics', {});
    expect(out.body).toContain('poker_humans_seated 1');
    expect(out.body).toContain('poker_horses_seated 463');
    expect(out.body).toContain('poker_tables_with_humans 1');
  });

  it('/stable-hand through the public proxy is refused before it reads anything', async () => {
    const out = await get('/stable-hand', { 'x-forwarded-for': '203.0.113.9' });
    expect(out.statusCode).toBe(401);
    expect(JSON.parse(out.body)).toEqual({ error: 'Unauthorized' });
  });
});
