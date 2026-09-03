/**
 * THE CLIENT MIRROR MUST AGREE WITH THE DATABASE.
 * ============================================================================
 * grantableRoles() in src/types/clubRoles.ts is a copy of
 * fn_club_grantable_roles in Postgres, kept so a screen can grey out a button
 * without a round trip. A copy that drifts is worse than no copy: it offers
 * buttons the server refuses, or hides ones it would have allowed.
 *
 * These cases are Dan's rules stated one at a time, and each was also run
 * against production as the real signed-in user before being written down:
 *
 *   "OWNERS CAN UPGRADE A PLAYER TO ANY ROLE STATUS, INCLUDING CO OWNER"
 *   "CO OWNERS AND ADMINS CAN PROMOTE ANY USER AS HIGH AS ADMIN STATUS"
 *   "SUPER AGENTS CAN PROMOTE ANY PLAYER IN THEIR DOWNLINES TO BE AN AGENT"
 *   "AGENTS CAN PROMOTE ANY PLAYER IN THEIR DOWNLINE TO BE A SUB AGENT"
 */

import { describe, it, expect } from 'vitest';
import {
  CLUB_ROLES,
  ROLE_RANK,
  ROLE_LABEL,
  ROLE_DESCRIPTION,
  grantableRoles,
  normaliseRole,
  isClubStaff,
  isClubPrincipal,
  isAgentRole,
} from '../../src/types/clubRoles';

describe('the seven roles', () => {
  it('has exactly the roles the database allows', () => {
    expect([...CLUB_ROLES]).toEqual([
      'owner',
      'co_owner',
      'admin',
      'super_agent',
      'agent',
      'sub_agent',
      'player',
    ]);
  });

  it('ranks them the same way fn_club_role_rank does', () => {
    expect(ROLE_RANK).toEqual({
      owner: 100,
      co_owner: 90,
      admin: 80,
      super_agent: 60,
      agent: 40,
      sub_agent: 20,
      player: 0,
    });
  });

  it('gives every role a label and a description', () => {
    for (const role of CLUB_ROLES) {
      expect(ROLE_LABEL[role], role).toBeTruthy();
      expect(ROLE_DESCRIPTION[role], role).toBeTruthy();
    }
  });

  it('maps the retired words onto player', () => {
    for (const old of ['member', 'manager', 'guest', '', null, undefined, 'nonsense']) {
      expect(normaliseRole(old)).toBe('player');
    }
  });
});

describe('grantableRoles mirrors fn_club_grantable_roles', () => {
  it('an owner may grant anything except owner', () => {
    expect(grantableRoles('owner', 'player')).toEqual([
      'co_owner',
      'admin',
      'super_agent',
      'agent',
      'sub_agent',
      'player',
    ]);
    expect(grantableRoles('owner', 'player')).not.toContain('owner');
  });

  it('a co-owner and an admin stop at admin', () => {
    for (const actor of ['co_owner', 'admin'] as const) {
      const roles = grantableRoles(actor, 'player');
      expect(roles, actor).toContain('admin');
      expect(roles, actor).not.toContain('co_owner');
      expect(roles, actor).not.toContain('owner');
    }
  });

  it('a co-owner cannot touch another co-owner, and an admin cannot touch an admin', () => {
    expect(grantableRoles('co_owner', 'co_owner')).toEqual([]);
    expect(grantableRoles('admin', 'admin')).toEqual([]);
    // ...but an owner can
    expect(grantableRoles('owner', 'co_owner')).toContain('player');
  });

  it('an admin cannot demote a co-owner', () => {
    expect(grantableRoles('admin', 'co_owner')).toEqual([]);
  });

  it('a super agent may make an agent, but only inside their downline', () => {
    expect(grantableRoles('super_agent', 'player', { inDownline: true })).toEqual([
      'agent',
      'player',
    ]);
    expect(grantableRoles('super_agent', 'player', { inDownline: false })).toEqual([]);
    // and nothing above agent, ever
    expect(grantableRoles('super_agent', 'player', { inDownline: true })).not.toContain('admin');
    expect(grantableRoles('super_agent', 'player', { inDownline: true })).not.toContain(
      'super_agent'
    );
  });

  it('an agent may make a sub agent, but only inside their downline', () => {
    expect(grantableRoles('agent', 'player', { inDownline: true })).toEqual([
      'sub_agent',
      'player',
    ]);
    expect(grantableRoles('agent', 'player', { inDownline: false })).toEqual([]);
    expect(grantableRoles('agent', 'player', { inDownline: true })).not.toContain('agent');
  });

  it('sub agents and players promote nobody', () => {
    for (const actor of ['sub_agent', 'player'] as const) {
      expect(grantableRoles(actor, 'player', { inDownline: true }), actor).toEqual([]);
    }
  });

  it('nobody edits their own role, not even the owner', () => {
    for (const actor of CLUB_ROLES) {
      expect(grantableRoles(actor, actor, { isSelf: true }), actor).toEqual([]);
    }
  });

  it('the club owner is never a target', () => {
    for (const actor of CLUB_ROLES) {
      expect(grantableRoles(actor, 'owner', { inDownline: true }), actor).toEqual([]);
    }
  });

  it('a platform admin acts with owner authority', () => {
    expect(grantableRoles('player', 'player', { isPlatformAdmin: true })).toContain('co_owner');
  });

  it('never offers a role the database does not have', () => {
    for (const actor of CLUB_ROLES) {
      for (const target of CLUB_ROLES) {
        for (const inDownline of [true, false]) {
          for (const role of grantableRoles(actor, target, { inDownline })) {
            expect(CLUB_ROLES, `${actor}->${target}`).toContain(role);
          }
        }
      }
    }
  });
});

describe('role predicates', () => {
  it('staff means owner, co-owner or admin', () => {
    expect(CLUB_ROLES.filter(isClubStaff)).toEqual(['owner', 'co_owner', 'admin']);
  });

  it('principal means owner or co-owner', () => {
    expect(CLUB_ROLES.filter(isClubPrincipal)).toEqual(['owner', 'co_owner']);
  });

  it('an agent role is one that carries a downline', () => {
    expect(CLUB_ROLES.filter(isAgentRole)).toEqual(['super_agent', 'agent', 'sub_agent']);
  });

  it('a retired word is treated as a player by every predicate', () => {
    expect(isClubStaff('manager')).toBe(false);
    expect(isAgentRole('member')).toBe(false);
  });
});
