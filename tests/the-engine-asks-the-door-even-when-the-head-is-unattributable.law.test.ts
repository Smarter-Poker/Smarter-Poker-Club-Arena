/**
 * THE ENGINE ASKS THE DOOR EVEN WHEN THE HEAD IS UNATTRIBUTABLE (2026-09-10).
 *
 * The database half of "a place is not a bounty" landed at 14:58 and the
 * knockout door began recording busts it had been refusing: 62 stranded busts
 * across ten events fell to 27 in seven minutes, and then stopped dead.
 *
 * The 33 that cleared were the ones stranded behind a PKO settlement watermark;
 * they HAD claimants, so the engine called the door and the corrected door
 * accepted them. The ones left were the ones with no exact pot claimant - and
 * for those the engine never called the door at all.
 *
 * `eliminatePlayer` loads bounty evidence first and returns false when it comes
 * back null, and `loadPersistedBountyEvidence` deferred on every unready gate
 * verdict including `knocker_not_attributable`. That is the same conflation the
 * door had, one level up: the engine refused to ASK whether a player busted
 * because it could not work out who to pay.
 *
 * THE RULE: `knocker_not_attributable` is the one gate verdict that says
 * nothing about whether the player busted. Everything before it - the accepted
 * zero-stack settlement, the matching atomic receipt, the player at zero in the
 * history roster, the live-seat veto - has already passed. So the engine admits
 * the elimination on the candidate's own evidence, marks the attribution
 * unavailable, passes NULL claimants (an empty array is refused as
 * `invalid_claimants`), accepts the door's `bounty_blocked` answer as a durable
 * commit with no obligation row, and pays nobody.
 *
 * EVERY OTHER VERDICT STILL DEFERS, and that is what this file mostly holds:
 * they each mean the bust itself is not proven, and placing a player on no
 * proof is worse than placing them late.
 *
 * docs/changelog/2026-09-10-a-place-is-not-a-bounty.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceMethod, sliceEnclosingBlock } from './helpers/sourceWindow';

const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const GATE = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/bountyAttributionGate.ts'),
  'utf8'
);

/**
 * Every deferral reason the gate can return. All but one mean the bust is not
 * proven; if a new one appears, this list must be revisited deliberately.
 */
const NOT_PROVEN = [
  'settlement_not_accepted',
  'settlement_not_zero',
  'settlement_identity_missing',
  'history_not_ready',
  'history_identity_mismatch',
  'player_not_in_hand',
];
const ATTRIBUTION_ONLY = 'knocker_not_attributable';

describe('the engine asks the door even when the head is unattributable', () => {
  it('the gate still distinguishes every reason it can defer for', () => {
    for (const reason of [...NOT_PROVEN, ATTRIBUTION_ONLY]) {
      expect(GATE, `${reason} must remain a distinct gate verdict`).toContain(`'${reason}'`);
    }
  });

  it('only the attribution verdict is admitted; every other one still defers', () => {
    const loader = sliceMethod(SOURCE, 'protected async loadPersistedBountyEvidence');
    expect(loader).toContain(`if (evidence.reason !== '${ATTRIBUTION_ONLY}') {`);
    expect(loader).toContain('is not authoritative (${evidence.reason})');
    // and the admitted branch marks itself, so nothing downstream can mistake
    // it for a payable claim
    expect(loader).toContain('attributionUnavailable: true');
    expect(loader).toContain("basis: 'none'");
    expect(loader).toContain('claimants: []');
    expect(loader).toContain('knockerUserId: null');
  });

  it('the bust evidence itself is still proven before anything is admitted', () => {
    const loader = sliceMethod(SOURCE, 'protected async loadPersistedBountyEvidence');
    // each of these deferrals sits ABOVE the admitted branch and is untouched
    for (const veto of [
      'latest knockout candidate has an invalid immutable identity',
      'multiple live tournament seats veto the candidate',
      'a different or funded live seat generation vetoes the candidate',
      'is not an exact zero-stack settlement',
      'does not match its candidate',
    ]) {
      expect(loader, `${veto} must still defer`).toContain(veto);
    }
  });

  it('an unattributable head proposes NULL claimants, never an empty array', () => {
    const claim = sliceEnclosingBlock(SOURCE, "'fn_claim_tournament_bounty_elimination',");
    expect(claim).toContain('headNotAttributable ? null : attribution.knockerUserId!');
    expect(claim).toContain('p_claimants: headNotAttributable');
    // the reason it matters, kept next to the code that depends on it
    expect(SOURCE).toContain('refused by the door as `invalid_claimants`');
  });

  it("the door's bounty_blocked answer is a durable commit with no obligation", () => {
    expect(SOURCE).toContain('bounty_blocked?: string | null;');
    expect(SOURCE).toContain('const bountyHeadNotAttributed =');
    // it is only ever read off an ACCEPTED response, never from an error
    const decided = sliceEnclosingBlock(SOURCE, 'const bountyHeadNotAttributed =');
    expect(decided).toContain('semanticClaimAccepted &&');
    // and with no obligation there is no knocker and no claimants to carry
    expect(SOURCE).toContain('durableBountyKnocker = null;');
    expect(SOURCE).toContain('durableBountyClaimants = [];');
  });

  it('nothing tries to collect a bounty that has no knocker', () => {
    expect(SOURCE).toContain(
      'if (bountyEvidence && bountyEvidence.attributionUnavailable !== true)'
    );
  });
});
