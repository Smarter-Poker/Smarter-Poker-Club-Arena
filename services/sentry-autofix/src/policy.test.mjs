import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate } from './policy.mjs';

// snapshot env so tests don't leak
const original = { ...process.env };
const reset = () => { for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]; Object.assign(process.env, original); };

test('gate allows created/error in allowed project', () => {
  reset();
  process.env.SENTRY_ALLOWED_PROJECTS = 'club-arena-client,club-arena-engine';
  process.env.AUTOFIX_ENABLED = 'true';
  const r = gate({
    action: 'created',
    project_slug: 'club-arena-client',
    data: { issue: { id: '1', level: 'error', type: 'error' } }
  });
  assert.equal(r.ok, true);
});

test('gate denies project not in allowlist', () => {
  reset();
  process.env.SENTRY_ALLOWED_PROJECTS = 'club-arena-client';
  const r = gate({ action: 'created', project_slug: 'other-app', data: { issue: { id: '1', level: 'error', type: 'error' } } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in SENTRY_ALLOWED_PROJECTS/);
});

test('gate denies fatal level', () => {
  reset();
  process.env.SENTRY_ALLOWED_PROJECTS = 'club-arena-client';
  const r = gate({ action: 'created', project_slug: 'club-arena-client', data: { issue: { id: '1', level: 'fatal', type: 'error' } } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fatal/);
});

test('gate denies when kill switch is off', () => {
  reset();
  process.env.SENTRY_ALLOWED_PROJECTS = 'club-arena-client';
  process.env.AUTOFIX_ENABLED = 'false';
  const r = gate({ action: 'created', project_slug: 'club-arena-client', data: { issue: { id: '1', level: 'error', type: 'error' } } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /kill switch/);
});

test('gate denies issues tagged no-autofix=true', () => {
  reset();
  process.env.SENTRY_ALLOWED_PROJECTS = 'club-arena-client';
  process.env.AUTOFIX_ENABLED = 'true';
  const r = gate({
    action: 'created',
    project_slug: 'club-arena-client',
    data: { issue: { id: '1', level: 'error', type: 'error', tags: [['no-autofix','true']] } }
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no-autofix/);
});

test('gate denies non-error issue types (performance, etc.)', () => {
  reset();
  process.env.SENTRY_ALLOWED_PROJECTS = 'club-arena-client';
  process.env.AUTOFIX_ENABLED = 'true';
  const r = gate({ action: 'created', project_slug: 'club-arena-client', data: { issue: { id: '1', level: 'error', type: 'performance' } } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not an error/);
});
