import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261016024912_cashier_sends_use_the_selected_source_and_destination_wallet.sql',
  'utf8'
);
const contract = readFileSync('scripts/verification-harness/cashier-release-contract.sql', 'utf8');

it.each([
  [
    'fn_cashier_batch_transfer',
    '4951dcaf2013c43faa90a7a707807ad3',
    '859bb844228d65085bf134c4dbd8b32b',
  ],
  [
    'fn_cashier_operation_intent_guard',
    '4441e55c7f8b750b93b513c6e18f3f24',
    '60350724279387da3b548bd370d082db',
  ],
  [
    'fn_promo_wallet_send_core_20261004',
    'b6b0c7686b67d33e2b01c132f8775cbc',
    '9902bccc4d422766b3611e050eeec770',
  ],
  [
    'fn_club_promo_send_core_20261004',
    '5990c675526e842d0671f47890c1ff27',
    '5d037d10de17314377a263d96a18556f',
  ],
])(
  'certifies installed %s from the qualified selected-wallet source',
  (name, bodyHash, definitionHash) => {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const definition = migration.slice(start);
    const match = definition.match(/\bAS (\$[A-Za-z0-9_]*\$)/i)!;
    expect(match).toBeTruthy();
    const bodyStart = match.index! + match[0].length;
    const bodyEnd = definition.indexOf(match[1], bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    expect(createHash('md5').update(definition.slice(bodyStart, bodyEnd)).digest('hex')).toBe(
      bodyHash
    );
    const proof = migration
      .split('\n')
      .find((line) => line.startsWith('-- @live-proof:') && line.includes(`public.${name}(`));
    expect(proof).toContain(`= '${definitionHash}'`);
    if (name === 'fn_club_promo_send_core_20261004') {
      // 20261020210238 later restricted agent banks inside this core; the
      // contract pins that committed successor body, never this one.
      const successor = readFileSync(
        'supabase/migrations/20261020210238_restrict_agent_banks_and_authorize_downline_reassignment.sql',
        'utf8'
      );
      const at = successor.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(at).toBeGreaterThanOrEqual(0);
      const next = successor.slice(at);
      const tag = next.match(/\bAS (\$[A-Za-z0-9_]*\$)/i)!;
      const from = tag.index! + tag[0].length;
      const successorHash = createHash('md5')
        .update(next.slice(from, next.indexOf(tag[1], from)))
        .digest('hex');
      expect(successorHash).not.toBe(bodyHash);
      expect(contract).toContain(`'hash', '${successorHash}'`);
      expect(contract).not.toContain(`'hash', '${bodyHash}'`);
      return;
    }
    const expected = name === 'fn_cashier_batch_transfer' ? definitionHash : bodyHash;
    expect(contract).toContain(`'hash', '${expected}'`);
  }
);
