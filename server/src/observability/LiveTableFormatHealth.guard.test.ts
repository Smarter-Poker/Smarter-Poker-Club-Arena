import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const gameServer = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');
const manager = readFileSync(join(here, '..', 'tournament', 'TournamentManagerBase.ts'), 'utf8');

describe('public table liveness carries category, never ownership authority', () => {
  it('derives tournament categories from the owning manager and cash locally', () => {
    const snapshot = sliceMethod(gameServer, 'private tableLivenessSnapshot()');

    expect(snapshot).toContain('manager.getPublicLiveTableFormat()');
    expect(snapshot).toContain('manager.getPublicLiveTableClubId()');
    expect(snapshot).toContain('manager.getTableIds()');
    expect(snapshot).toContain('tournamentDescriptorByTableId.get(id)');
    expect(snapshot).toContain("engine.isTournament() ? null : 'cash'");
  });

  it('does not copy a lease proof or private tournament row into health', () => {
    const snapshot = sliceMethod(gameServer, 'private tableLivenessSnapshot()');
    const getter = sliceMethod(manager, 'getPublicLiveTableFormat()');
    const clubGetter = sliceMethod(manager, 'getPublicLiveTableClubId()');

    expect(snapshot).not.toContain('getTournamentLeaseGeneration(');
    expect(snapshot).not.toContain('getEngineLeaseAuthority(');
    expect(snapshot).not.toContain('tournamentCache:');
    expect(getter).toContain('publicTournamentTableFormat(this.tournamentCache)');
    expect(getter).not.toContain('this.tournamentLeaseGeneration');
    expect(clubGetter).toContain('this.tournamentCache?.club_id');
    expect(clubGetter).not.toContain('this.tournamentLeaseGeneration');
  });
});
