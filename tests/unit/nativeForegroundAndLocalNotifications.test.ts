/**
 * Store readiness, tier 3: audio comes back after a phone call, and the
 * worker's background banners exist in the app too.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

function fakeCtx(state: string) {
  const resume = vi.fn(async () => {});
  return { ctx: { state, resume } as unknown as AudioContext, resume };
}

describe('every AudioContext the app creates can be resumed from one place', () => {
  it('resumes what is suspended or interrupted, skips running and closed, and forgets dropped ones', async () => {
    const { trackAudioContext, resumeTrackedAudioContexts } =
      await import('../../src/lib/audioContexts');
    const a = fakeCtx('suspended');
    const b = fakeCtx('interrupted'); // iOS, after a phone call
    const c = fakeCtx('running');
    const d = fakeCtx('closed');
    for (const x of [a, b, c, d]) trackAudioContext(x.ctx);
    trackAudioContext(null);
    expect(resumeTrackedAudioContexts()).toBe(2);
    expect(a.resume).toHaveBeenCalledTimes(1);
    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(c.resume).not.toHaveBeenCalled();
    expect(d.resume).not.toHaveBeenCalled();
  });

  it('the three sound engines register their contexts, and the shell resumes them on appStateChange', () => {
    for (const f of [
      'src/services/SoundService.ts',
      'src/services/PremiumSFX.ts',
      'src/services/ThrowableSoundService.ts',
    ]) {
      const src = read(f);
      expect(src, f).toContain("from '../lib/audioContexts'");
      expect(src, f).toMatch(/trackAudioContext\((this\.ctx|_ctx)\)/);
    }
    const shell = read('src/lib/nativeShell.ts');
    expect(shell).toContain("App.addListener('appStateChange'");
    expect(shell).toContain('if (isActive) resumeTrackedAudioContexts();');
  });
});

describe('the worker banners exist in the app as local notifications', () => {
  it('keeps the worker body rules and drops its emoji', async () => {
    const { notificationBody, notificationTitle } =
      await import('../../src/lib/native/localNotifications');
    expect(notificationTitle('TABLE_SEATED')).toBe('Seated At Table');
    expect(notificationTitle('SOMETHING_ELSE')).toBe('Something Else');
    expect(notificationBody('BALANCE_UPDATED', { source: 'rakeback' })).toBe('Source: rakeback');
    expect(notificationBody('CLUB_JOINED', { clubName: 'shark CLUB' })).toBe('Shark Club');
    expect(notificationBody('TABLE_LEFT', { tableId: 't1' })).toBe('Table: t1');
    expect(notificationBody('FINANCIAL_ALERT', null)).toBe('');
    const src = read('src/lib/native/localNotifications.ts');
    expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('MasterBus routes CRITICAL_EVENTS to the plugin in the app and to the worker on the web, never both', () => {
    const bus = read('src/core/MasterBus.ts');
    const branch = bus.indexOf('if (IS_NATIVE_BUILD) {');
    const native = bus.indexOf("import('../lib/native/localNotifications')");
    const worker = bus.indexOf('navigator.serviceWorker.controller.postMessage({');
    expect(branch).toBeGreaterThan(-1);
    expect(native).toBeGreaterThan(branch);
    expect(worker).toBeGreaterThan(native);
    expect(bus.slice(branch, worker)).toContain('} else {');
  });

  it('never asks for permission itself and shows nothing while the app is active', () => {
    const src = read('src/lib/native/localNotifications.ts');
    expect(src).not.toContain('requestPermissions');
    expect(src).toContain('if (isActive) return false;');
    expect(src).toContain("if (display !== 'granted') return false;");
  });
});
