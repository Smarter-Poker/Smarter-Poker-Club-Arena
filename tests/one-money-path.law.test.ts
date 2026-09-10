/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE MONEY PATH (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 3 of 7 of the agent credit and promotion lifecycle work.
 *
 * Dan, 2026-08-25, binding: "Any chips sent or claimed back transact from the
 * Agent Wallet." And 2026-08-31: "CHIPS MUST FLOW FROM THE MAIN BANK TO THE
 * AGENT WALLET TO SEND OUT TO AGENTS AND PLAYERS."
 *
 * ChipTransferModal was a FOURTH money path and it moved the wrong accounts.
 * It called ChipFlowService.clubToAgent / clubToPlayer / agentToPlayer, all
 * three peer-to-peer moves between two users' PLAYER wallets:
 *
 *   1. clubToAgent debited the OWNER'S PERSONAL wallet, never
 *      clubs.chip_treasury, despite being named for the club bank.
 *   2. agentToPlayer debited the agent's own PLAYER wallet, never
 *      agents.agent_wallet_balance. Its own doc comment said so.
 *   3. The balance it displayed AND validated against was the viewer's global
 *      player wallet, which is not the account any of those sends debited. An
 *      agent with a funded agent wallet was refused by their own browser.
 *   4. No idempotency key, so a lost response and the obvious retry sent twice.
 *   5. No downline check, and a recipient list that offered an agent the whole
 *      club, so the modal advertised transfers the server refuses.
 *   6. No result check, so a refusal still printed "Transferred".
 *
 * CashierPage.tsx:1430-1455 documented this exact bug when the Cashier was
 * fixed on 2026-08-27. The Cashier was fixed; the modal was left behind.
 *
 * These are source-text pins. The behaviour spans a browser, two RPCs and a
 * trigger, and a unit test cannot run all three; what it CAN do is refuse to
 * let the wiring go back to what it was.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/** Strips comments, so a "must not appear" pin cannot match its own explanation. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const MODAL = read('src/components/agent/ChipTransferModal.tsx');
const MODAL_CODE = codeOnly(MODAL);
const INTENT_CODE = codeOnly(read('src/services/AgentWalletIntent.ts'));
const TRANSFER_CODE = MODAL_CODE.slice(
  MODAL_CODE.indexOf('const handleTransfer = async () => {'),
  MODAL_CODE.indexOf('const handleClose = () => {')
);
const CHIPFLOW = read('src/services/ChipFlowService.ts');
const CHIPFLOW_CODE = codeOnly(CHIPFLOW);

describe('the modal is no longer a fourth money path', () => {
  it('does not import ChipFlowService at all', () => {
    expect(MODAL_CODE).not.toContain("from '../../services/ChipFlowService'");
    expect(MODAL_CODE).not.toMatch(/ChipFlowService\.\w+\(/);
  });

  it('sends through the two canonical RPCs and nothing else', () => {
    expect(MODAL_CODE).toMatch(/viaClubBank \? 'fn_club_bank_send' : 'fn_agent_wallet_send'/);
    expect(MODAL_CODE).not.toMatch(/atomic_chip_transfer/);
  });

  /**
   * The four bank roles spend the club treasury; the three agent roles spend
   * their own float. walletRows is the single home of that rule and
   * fn_can_use_club_bank enforces the same four roles server-side, so the
   * client must not re-list them by hand.
   */
  it('routes by the caller role, from the one place that rule lives', () => {
    expect(MODAL_CODE).toMatch(/CLUB_BANK_ROLES\.includes\(normaliseRole\(senderRole\)\)/);
    expect(MODAL_CODE).toMatch(/from '\.\.\/wallet\/walletRows'/);
  });

  it('derives the destination from the recipient, not from the caller', () => {
    // Phase 5 (2026-09-04): the recipient is REQUIRED to be known before the
    // send runs. `recipientData?.role` used to fall through to
    // 'player_wallet' while the recipient list was still loading, and
    // fn_club_bank_send honours p_destination, so funding a freshly promoted
    // agent could land in their player wallet.
    expect(MODAL_CODE).toMatch(
      /const destination = canHoldAgentWallet\(recipientData\.role\) \? 'agent_wallet' : 'player_wallet'/
    );
    expect(MODAL_CODE).not.toMatch(/canHoldAgentWallet\(recipientData\?\.role\)/);
    expect(MODAL_CODE).toMatch(/if \(!selectedRecipientData\) \{/);
    expect(TRANSFER_CODE).toMatch(/p_destination: destination/);
    expect(TRANSFER_CODE.indexOf('if (!selectedRecipientData)')).toBeLessThan(
      TRANSFER_CODE.indexOf('const destination =')
    );
  });
});

describe('a lost response cannot send twice', () => {
  it('every send carries a uuid op_id', () => {
    expect(TRANSFER_CODE).toMatch(/await runAgentWalletOperation\(/);
    expect(TRANSFER_CODE).toMatch(/async \(operation\) => \{/);
    expect(TRANSFER_CODE).toMatch(/p_op_id: operation\.operationId/);
    expect(INTENT_CODE).toMatch(/const operation = await reserveAgentWalletOperation\(intent\);/);
    expect(INTENT_CODE).toMatch(/await submit\(operation\);/);
  });

  /**
   * A key minted inside the call protects nothing: the dangerous shape is
   * commit, lost response, user retry - and the retry must present the SAME key
   * so the server replays instead of debiting again.
   */
  it('holds the key across a retry and rotates it only when the intent changes', () => {
    expect(TRANSFER_CODE).toMatch(
      /runAgentWalletOperation\(\s*\{\s*userId: user\.id,\s*clubId: resolvedForSend,\s*targetId: selectedRecipient,\s*kind,\s*destination,\s*amount: transferAmount,/
    );
    for (const field of ['userId', 'clubId', 'targetId']) {
      expect(INTENT_CODE).toContain(`intent.${field}.toLowerCase()`);
    }
    expect(INTENT_CODE).toContain('intent.kind');
    expect(INTENT_CODE).toContain('intent.amount.toFixed(2)');
    expect(INTENT_CODE).toContain("intent.destination === 'agent_wallet' ? ['agent_wallet'] : []");
    expect(INTENT_CODE).toMatch(
      /const prior = session\.getItem\(key\) \?\? storage\.getItem\(key\);/
    );
    expect(INTENT_CODE).toMatch(/return \{ key, operationId: prior \};/);
    expect(INTENT_CODE).toMatch(
      /await submit\(operation\);\s*await completeAgentWalletOperation\(operation\);/
    );
    expect(TRANSFER_CODE).not.toMatch(/sendOpIdRef|opIdSeedRef|uuid\(\)/);
  });

  /**
   * crypto.randomUUID is undefined on non-secure origins and in older Safari,
   * and p_op_id is typed uuid - so a fallback that is not a uuid fails with
   * 22P02 on exactly the browsers that lack it. There is already one shared
   * implementation; a fourth local copy is how they drift.
   */
  it('uses the shared uuid helper rather than a fourth local shim', () => {
    expect(MODAL_CODE).toContain("from '../../services/AgentWalletIntent'");
    expect(INTENT_CODE).toContain("import { uuid } from '../utils/uuid'");
    expect(INTENT_CODE).toContain('const operationId = uuid();');
    expect(MODAL_CODE).not.toMatch(/function newOpId|crypto\.randomUUID|uuid\(\)/);
  });

  it('reports a replayed send as already done, not as a second transfer', () => {
    expect(TRANSFER_CODE).toMatch(
      /confirmationHeadline = sendData\.replayed\s*\? `That Transfer Had Already Gone Through/
    );
  });
});

describe('the number on screen is the account that gets debited', () => {
  it('reads the club treasury for a bank role and the agent wallet otherwise', () => {
    expect(MODAL_CODE).toMatch(/\.from\('clubs'\)\s*\n?\s*\.select\('chip_treasury'\)/);
    expect(MODAL_CODE).toMatch(/\.from\('agents'\)\s*\n?\s*\.select\('agent_wallet_balance'\)/);
  });

  it('no longer validates the send against the global player wallet', () => {
    expect(MODAL_CODE).not.toMatch(/WalletService\.readPlayerBalance/);
    expect(MODAL_CODE).not.toContain("from '../../services/WalletService'");
  });

  /**
   * A failed read is UNKNOWN, not zero. senderBalance gates the send, so a
   * collapsed failure would block a send the server would have allowed - the
   * same defect the 2026-08-25 audit removed from the tournament sign-up gate.
   */
  it('treats an unreadable balance as unknown rather than as empty', () => {
    expect(MODAL_CODE).toMatch(/useState<number \| null>\(null\)/);
    // The client float guard applies to the club bank only: an agent wallet
    // can draw on a credit line this browser cannot see.
    expect(MODAL_CODE).toMatch(
      /viaClubBank && senderBalance !== null && transferAmount > senderBalance/
    );
  });

  it('names the account on screen', () => {
    // Three states since phase 5: the role is UNKNOWN until read, and an
    // unknown role names neither account (and cannot send).
    expect(MODAL_CODE).toMatch(
      /const sourceLabel = !senderKnown \? 'Wallet' : viaClubBank \? 'Club Bank' : 'Agent Wallet'/
    );
    expect(MODAL_CODE).toMatch(/const senderKnown = senderRole !== null;/);
  });
});

describe('the list agrees with the server', () => {
  /**
   * Dan, 2026-08-25: "Super Agents, Agents, and Sub Agents should ONLY EVER SEE
   * their downlines, and their downline agents' downlines. Nobody else."
   * fn_club_cashier_members walks the same recursive club_members.agent_id edge
   * that fn_club_cashier_can_transact refuses on, so the list and the refusal
   * cannot disagree.
   */
  it('asks the database who an agent may pay', () => {
    expect(MODAL_CODE).toMatch(/supabase\.rpc\('fn_club_cashier_members'/);
  });

  it('does not offer an agent a self-send the server refuses outright', () => {
    expect(MODAL_CODE).toMatch(/\.filter\(\(m\) => String\(m\.user_id\) !== user\.id\)/);
  });

  it('checks the result, so a refusal cannot print success', () => {
    expect(TRANSFER_CODE).toMatch(/if \(sendError\) throw sendError;/);
    expect(TRANSFER_CODE).toMatch(
      /if \(!confirmedAgentWalletReceipt\(sendData, transferAmount, kind, destination\)\) \{\s*throw new Error\(sendData\?\.error \|\| 'The Cashier Did Not Confirm That Transfer'\);\s*\}/
    );
    for (const proof of [
      'r.success === true',
      'UUID.test(r.transaction_id)',
      'r.amount === amount',
      'Number.isFinite(sourceBalance)',
      'sourceBalance >= 0',
      'Number.isFinite(balance)',
      'balance >= 0',
      "kind === 'self_stake' || r.destination === destination",
    ]) {
      expect(INTENT_CODE).toContain(proof);
    }
    expect(TRANSFER_CODE.indexOf('if (!confirmedAgentWalletReceipt(')).toBeLessThan(
      TRANSFER_CODE.indexOf('confirmationHeadline = sendData.replayed')
    );
    expect(TRANSFER_CODE).toMatch(/\n {8}\}\n {6}\);\n {6}if \(!isMounted\.current\) return;/);
    expect(TRANSFER_CODE.indexOf('confirmationHeadline = sendData.replayed')).toBeLessThan(
      TRANSFER_CODE.indexOf('setSuccess(headline)')
    );
  });

  /** Phase 2 made the line drawable; a send funded by it is a debt, not float. */
  it('says when a send was funded from the credit line', () => {
    expect(MODAL_CODE).toMatch(/credit_drawn/);
    expect(MODAL_CODE).toMatch(/On Credit/);
  });
});

describe('the ledger reason names the account that actually paid', () => {
  /**
   * Found in the phase 3 audit pass. The reason string is written into the
   * chip_transactions row and is what somebody reads back months later, so it
   * has to name the source the money really came from.
   *
   * It asked isClubStaff, which is owner, co_owner and admin - ONE ROLE SHORT
   * of the four that spend the club bank. A super agent therefore debited the
   * club treasury while the ledger recorded "Agent -> ...: player funding".
   * It now follows the same viaClubBank the send routes on, so the row and the
   * money cannot disagree.
   */
  it('describes a super agent send as the club bank, because that is what it debits', () => {
    expect(MODAL_CODE).toMatch(/if \(viaClubBank\) \{\s*\n\s*return `\$\{clubName\}/);
    expect(MODAL_CODE).not.toMatch(/if \(isClubStaff\(senderRole\)\) \{/);
  });

  it('never prints a transfer to "undefined" when the recipient arrived as a prop', () => {
    const messages = MODAL_CODE.match(/Transferred \$\{transferAmount[^`]*/g) ?? [];
    expect(messages.length).toBeGreaterThan(0);
    expect(TRANSFER_CODE).toMatch(/if \(!selectedRecipientData\) \{[\s\S]*?return;\s*\}/);
    expect(TRANSFER_CODE).toContain('const recipientData = selectedRecipientData;');
    for (const m of messages) expect(m).toMatch(/recipientData\.username \|\| 'Them'/);
  });
});

describe('the dead hierarchy methods are gone', () => {
  it('ChipFlowService no longer exposes clubToAgent, agentToPlayer or clubToPlayer', () => {
    expect(CHIPFLOW_CODE).not.toMatch(/async clubToAgent\(/);
    expect(CHIPFLOW_CODE).not.toMatch(/async agentToPlayer\(/);
    expect(CHIPFLOW_CODE).not.toMatch(/async clubToPlayer\(/);
  });

  /**
   * `transfer` is NOT one of the three. It is a genuine player-to-player wallet
   * move and AgentService still calls it, so deleting it would break the
   * commission and settlement paths.
   */
  it('keeps the generic transfer the rest of the app still uses', () => {
    expect(CHIPFLOW_CODE).toMatch(/async transfer\(/);
  });

  it('nothing in the app calls the removed methods any more', () => {
    const SOURCES = ['src/pages/AgentManagementPage.tsx', 'src/services/AgentService.ts'];
    for (const f of SOURCES) {
      expect(codeOnly(read(f))).not.toMatch(
        /ChipFlowService\.(clubToAgent|agentToPlayer|clubToPlayer)\(/
      );
    }
  });
});
