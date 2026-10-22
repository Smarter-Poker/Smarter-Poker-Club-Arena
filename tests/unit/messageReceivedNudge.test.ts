import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NUDGE_MOMENTS, OWNER_USER_ID, decideNudge } from '@/lib/pushNudgePolicy';

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

describe('a received message asks the player to turn on alerts', () => {
  it('message_received is a shared enrollment moment with its own copy', () => {
    expect(NUDGE_MOMENTS).toContain('message_received');
    expect(read('src/components/notifications/FirstRunPushPrompt.tsx')).toMatch(
      /message_received:\s*\{\s*title: 'Get Your Messages On This Device'/
    );
  });

  it('the message alerts host raises the moment for every new message', () => {
    expect(read('src/components/common/MessageAlertsHost.tsx')).toMatch(
      /requestPushNudge\('message_received'\)/
    );
  });

  it('asks a player who never enrolled, and respects every existing guard', () => {
    const READY = {
      supported: true,
      iosNeedsInstall: false,
      permission: 'default',
      subscribed: false,
      optedOut: false,
    };
    const now = Date.now();
    const base = { userId: 'player-1', moment: 'message_received', now, device: READY };
    expect(decideNudge(base)).toMatchObject({ show: true, variant: 'ask' });
    expect(decideNudge({ ...base, device: { ...READY, subscribed: true } }).show).toBe(false);
    expect(decideNudge({ ...base, device: { ...READY, optedOut: true } }).show).toBe(false);
    expect(decideNudge({ ...base, device: { ...READY, permission: 'denied' } }).show).not.toBe(
      true
    );
    // Messages are not receipts, so the owner is asked like anyone else.
    expect(decideNudge({ ...base, userId: OWNER_USER_ID }).show).toBe(true);
  });
});
