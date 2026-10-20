/**
 * A TAP IS NEVER A DEAD END (Dan 2026-10-19)
 *
 * "when i click a player ... it should open up to that user ... currently it
 * does nothing and silently fails." The wallet roster is pinned by
 * wallet-recipient-tap-opens-send.law.test.tsx; the sweep that followed found
 * two more controls of the same kind, pinned here:
 *
 *  - FriendListPanel: the Profile page mounts it with no handlers, so tapping a
 *    friend only buzzed and the Message button was a blank circle that did
 *    nothing. A friend tap now opens their profile, and a Message control with
 *    no destination is not shown.
 *  - AgentTree: the per-agent transfer control was an empty square while the
 *    row body opens Commission History, so a send was undiscoverable.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('a tap is never a dead end', () => {
  const friends = src('src/components/social/FriendListPanel.tsx');
  const tree = src('src/components/agent/AgentTree.tsx');

  it('a friend tap opens their profile when the host passes no handler', () => {
    expect(friends).toMatch(/navigate\(`\/profile\/\$\{friendId\}`\)/);
    expect(friends).not.toMatch(/onProfileClick\?\.\(/);
  });

  it('a Message control is only rendered when it has somewhere to go', () => {
    expect(friends).not.toMatch(/onMessageClick\?\.\(/);
    expect(friends).toMatch(/\{onMessageClick && \(/);
  });

  it('the agent transfer control says what it does', () => {
    const btn = tree.match(/className=\{styles\.transferBtn\}[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(btn).toMatch(/>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?Send Chips\s*<\/button>/);
  });
});
