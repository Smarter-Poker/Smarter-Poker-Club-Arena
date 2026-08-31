/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PROMOTION DOES NOT END AT THE ROLE (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 5 of 7, client half.
 *
 * TWO GAPS, BOTH OF THE SAME SHAPE: the database could do the thing, and no
 * screen asked it to.
 *
 * 1. FUNDING. A promotion assigns the TERMS - commission, rakeback, prepaid or
 *    a credit line - and not one chip. A prepaid agent with an empty wallet
 *    cannot send anything at all: fn_agent_wallet_send refuses them for want of
 *    float, and the credit path is closed to them by definition. The person who
 *    just promoted them is the person holding the club bank, standing in front
 *    of the screen that can fix it, and was shown nothing.
 *
 * 2. HANDOVER. transfer_club_ownership has always permitted the owner to hand
 *    the club over - it checks the caller IS the current owner and refuses
 *    anybody else - but the only screen that called it was AdminDashboardPage,
 *    which a club owner cannot open. The one person the rule was written for
 *    had to ask a platform admin to do it for them.
 *
 * These pins are deliberately about WIRING, not appearance: that the offer is
 * made, that it is an offer and not an action, that it is aimed at the right
 * person, and that the handover control exists where an owner can reach it and
 * cannot fire by accident.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceMethod, sliceBetween } from './helpers/sourceWindow';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MEMBER_PAGE = read('src/pages/MemberManagementPage.tsx');
const SETTINGS_PAGE = read('src/pages/ClubSettingsPage.tsx');

describe('an agent promoted with no chips is offered the chips', () => {
  it('offers the funding step from the promotion screen itself', () => {
    expect(MEMBER_PAGE).toMatch(
      /import ChipTransferModal from '\.\.\/components\/agent\/ChipTransferModal';/
    );
    expect(MEMBER_PAGE).toMatch(/Fund Them Now\?/);
    expect(MEMBER_PAGE).toMatch(/Their Agent Wallet Is Empty/);
  });

  it('asks only after an AGENT promotion, and only when the wallet is empty', () => {
    expect(MEMBER_PAGE).toMatch(/if \(isAgentRole\(newRole\)\) \{/);
    expect(MEMBER_PAGE).toMatch(/\.select\('agent_wallet_balance'\)/);
    expect(MEMBER_PAGE).toMatch(/if \(float_ <= 0\) \{/);
    expect(MEMBER_PAGE).toMatch(/setFundPrompt\(\{ role: newRole \}\)/);
  });

  it('is an offer: "Not Now" is a real answer that finishes the flow', () => {
    expect(MEMBER_PAGE).toMatch(/Not Now/);
    // Both the decline and the modal close must release the screen, or the
    // promotion appears to hang on a question nobody has to answer.
    // Bounded by the button it belongs to: from the decline button's className
    // to its label. Both live inside the same element, so the window closes on
    // the structure rather than on a count of characters.
    const declineHandler = sliceBetween(MEMBER_PAGE, 'className="mm-roles__confirm-no"', 'Not Now');
    expect(declineHandler).toMatch(/setFundPrompt\(null\);/);
    expect(declineHandler).toMatch(/onRoleChanged\(\)/);
  });

  it('aims the transfer at the person who was just promoted', () => {
    expect(MEMBER_PAGE).toMatch(/recipientId=\{targetUserId\}/);
    expect(MEMBER_PAGE).toMatch(/clubId=\{resolvedClubId\}/);
  });

  it('never fails a promotion that already succeeded, for want of a balance', () => {
    // The balance read is wrapped, and an unreadable balance still asks.
    const guard = MEMBER_PAGE.slice(
      MEMBER_PAGE.indexOf('if (isAgentRole(newRole)) {'),
      MEMBER_PAGE.indexOf('setFundPrompt({ role: newRole })')
    );
    expect(guard).toMatch(/try \{/);
    expect(guard).toMatch(/reportError\(e, 'MemberManagementPage\.fundPromptBalance'\)/);
  });
});

describe('an owner can hand over their own club', () => {
  it("puts the control on the owner's settings page, gated on isOwner", () => {
    expect(SETTINGS_PAGE).toMatch(/Hand Over This Club/);
    expect(SETTINGS_PAGE).toMatch(/className="settings-section handover-section"/);
    const section = SETTINGS_PAGE.slice(
      SETTINGS_PAGE.indexOf('{/* Ownership - Owner Only */}'),
      SETTINGS_PAGE.indexOf('{/* Danger Zone - Owner Only */}')
    );
    expect(section).toMatch(/\{isOwner && \(/);
  });

  it('calls the one RPC and re-implements none of its rules', () => {
    expect(SETTINGS_PAGE).toMatch(/supabase\.rpc\('transfer_club_ownership'/);
    expect(SETTINGS_PAGE).toMatch(/p_new_owner_id: handoverTarget/);
  });

  it('offers only members the RPC would actually accept', () => {
    expect(SETTINGS_PAGE).toMatch(
      /const HANDOVER_ELIGIBLE_STATUSES = new Set\(\['active', 'approved'\]\);/
    );
    expect(SETTINGS_PAGE).toMatch(/m\.userId !== user\?\.id/);
  });

  it('cannot fire by accident: a member AND the typed club name', () => {
    expect(SETTINGS_PAGE).toMatch(/Type <strong>\{savedClubName\}<\/strong> To Confirm/);
    expect(SETTINGS_PAGE).toMatch(/handoverConfirm\.trim\(\) !== savedClubName\.trim\(\)/);
    expect(SETTINGS_PAGE).toMatch(/!handoverTarget \|\|/);
  });

  it('is a real dialog: modal semantics, Escape, and focus returned', () => {
    // The dialog's own opening tag, bounded by the two attributes that fence
    // it - not by a byte count, and not from the id it points at, which appears
    // on the <h3> below as well.
    const dialog = sliceBetween(
      SETTINGS_PAGE,
      'className="modal-content handover-modal"',
      'onClick={(e) => e.stopPropagation()}'
    );
    expect(dialog).toMatch(/role="dialog"/);
    expect(dialog).toMatch(/aria-modal="true"/);
    expect(dialog).toMatch(/aria-labelledby="handover-club-title"/);
    expect(SETTINGS_PAGE).toMatch(
      /if \(e\.key === 'Escape' && !isHandingOverRef\.current\) setShowHandoverModal\(false\);/
    );
    expect(SETTINGS_PAGE).toMatch(/handoverTriggerRef\.current\?\.focus\(\);/);
  });

  it("shows the server's own reason when it refuses", () => {
    expect(SETTINGS_PAGE).toMatch(/e instanceof Error && e\.message/);
    expect(SETTINGS_PAGE).toMatch(/The Handover Was Refused\. Nothing Was Changed\./);
  });

  it('does not leave owner-only controls on screen for a former owner', () => {
    const handler = sliceMethod(SETTINGS_PAGE, 'const handOverClub = async () => {');
    expect(handler).toMatch(/navigate\(`\/clubs\/\$\{clubId\}`, \{ replace: true \}\)/);
  });
});
