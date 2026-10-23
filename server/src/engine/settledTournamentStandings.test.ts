import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { channelHub } from '../hub/ChannelHub.js';
import { publishSettledTournamentHand } from './settledTournamentStandings.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const users = ['at-table-one', 'at-table-two', 'lobby-viewer', 'other-event'];
afterEach(() => {
  for (const user of users) channelHub.removeConnection(user);
  vi.restoreAllMocks();
});

describe('accepted hand standings reach the entire MTT', () => {
  it('fans out across tables and lobby, while isolating another tournament', () => {
    const sends = users.map(() => vi.fn());
    users.forEach((user, i) => {
      channelHub.addConnection(user, { readyState: 1, send: sends[i] } as any);
      channelHub.joinTournament(user, i === 3 ? 'other' : 'mtt');
    });
    publishSettledTournamentHand('mtt', 'table-two', 17);
    for (const send of sends.slice(0, 3)) {
      expect(send).toHaveBeenCalledOnce();
      expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
        type: 'TOURNAMENT_EVENT',
        tournamentId: 'mtt',
        event: { type: 'standings_changed', payload: { tableId: 'table-two', handNumber: 17 } },
      });
    }
    expect(sends[3]).not.toHaveBeenCalled();
  });
  it('cannot turn a presentation failure into a failed accepted hand', () => {
    vi.spyOn(channelHub, 'broadcastToTournament').mockImplementation(() => {
      throw new Error('closed');
    });
    expect(() => publishSettledTournamentHand('mtt', 'table', 1)).not.toThrow();
  });
  it('is wired after exact settlement proof and before post-commit follow-up', () => {
    const source = readFileSync('src/engine/ServerTableEngineSettlement.ts', 'utf8');
    const proof = source.indexOf('if (!authoritativeCommitSucceeded)');
    const announce = source.indexOf('publishSettledTournamentHand(standingsTournamentId');
    const obligations = source.indexOf('let postCommitStateCanReflect');
    expect(proof).toBeGreaterThan(0);
    expect(announce).toBeGreaterThan(proof);
    expect(announce).toBeLessThan(obligations);
    expect(source.slice(proof, announce)).toContain('throw new Error(');
    expect(source.slice(proof, announce)).toContain('this.lifecycleCanMutate()');
  });
});
