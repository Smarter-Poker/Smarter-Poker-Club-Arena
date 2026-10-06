import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { declaredProofs, proofIsRunnable } from '../scripts/ci/check-migrations-are-live.mjs';

const migration = readFileSync(
  'supabase/migrations/20261006040331_dispute_mutation_receipts_name_their_dispute.sql',
  'utf8'
);

const publicFunctions = [
  'fn_dispute_submit',
  'fn_dispute_withdraw',
  'fn_dispute_start_review',
  'fn_resolve_dispute',
  'fn_dispute_escalate',
];

const livePreimages = [
  {
    signature: 'fn_dispute_submit(text,text,uuid,numeric,text)',
    prosrcMd5: 'ab840fc0effa6e0311edbfdb7fea80eb',
    definitionMd5: '8a452fbe914ff31573b150256ae8b627',
  },
  {
    signature: 'fn_dispute_withdraw(uuid)',
    prosrcMd5: '5ae9b29dd8aa017a2de491f00e4a57fd',
    definitionMd5: 'dd43749c39a2a5ed7e47b1f76e94e519',
  },
  {
    signature: 'fn_dispute_start_review(uuid)',
    prosrcMd5: '83150bbcf8384879c5a5722a71157fa6',
    definitionMd5: 'b8b36f4a2cb2d1d71ea325a27230c7ea',
  },
  {
    signature: 'fn_resolve_dispute(uuid,text,text,numeric)',
    prosrcMd5: 'c3d4178a49d11c40289b4700bc523e4b',
    definitionMd5: 'ce3e71513f10822e42517b3a7e816f67',
  },
  {
    signature: 'fn_dispute_escalate(uuid,text)',
    prosrcMd5: '7c9eb137108a2022f408d849d0070593',
    definitionMd5: '5b873bd9d3f55597bae19a0075a9bc8f',
  },
] as const;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('request-bound dispute mutation receipts', () => {
  it('declares one runnable durable postimage proof', () => {
    const proofs = declaredProofs(migration);

    expect(proofs).toHaveLength(1);
    expect(proofIsRunnable(proofs[0])).toBe(true);
    expect(proofs[0]).toContain('count(*) = 5');
    expect(proofs[0]).toContain('NOT EXISTS');
  });

  it('preserves every implementation as a private core behind the maintained API name', () => {
    for (const name of publicFunctions) {
      expect(migration).toMatch(new RegExp(`ALTER FUNCTION public\\.${name}\\(`));
      expect(migration).toContain(`RENAME TO ${name}_receipt_core_20261006`);
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${name}_receipt_core_20261006\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role;`
        )
      );
      expect(migration).toMatch(new RegExp(`CREATE FUNCTION public\\.${name}\\(`));
    }
  });

  it('binds every public receipt to the requested dispute and retains literal outcomes', () => {
    expect(migration.match(/jsonb_build_object\('dispute_id'/g)).toHaveLength(5);
    expect(migration).toContain("v_out->'ok' = 'true'::jsonb");
    expect(migration).toContain("jsonb_build_object('status', 'resolved')");
    expect(migration).toContain("jsonb_typeof(v_out) IS DISTINCT FROM 'object'");
  });

  it.each(livePreimages)(
    '$signature must match both immutable production preimages before becoming a core',
    ({ signature, prosrcMd5, definitionMd5 }) => {
      expect(migration).toMatch(
        new RegExp(
          `'public\\.${escapeRegExp(signature)}'::regprocedure,\\s*` +
            `'${prosrcMd5}'::text,\\s*'${definitionMd5}'::text`
        )
      );
    }
  );

  it('pins the exact production ACL before retaining the mutation implementations', () => {
    expect(migration).toContain(
      "p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'"
    );
  });

  it('retains the public authority boundary and registers the private money core', () => {
    for (const name of publicFunctions) {
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon;`)
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?TO authenticated, service_role;`
        )
      );
    }
    expect(migration).toContain("'fn_resolve_dispute_receipt_core_20261006'");
    expect(migration).toContain("'approved'");
    expect(migration).toContain('DISPUTE_RESOLUTION_CORE_UNREGISTERED');
  });

  it('is one guarded transaction with no scaffold left behind', () => {
    expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;\s*$/);
    expect(migration).toContain('DISPUTE_RECEIPT_PREIMAGE_DRIFT');
    expect(migration).toContain('DISPUTE_RECEIPT_POSTIMAGE_DRIFT');
    expect(migration).not.toContain('-- your change here');
  });
});
