/**
 * LAW: AN OPEN WEEK HAS NO ECO TO RECORD (2026-10-12).
 *
 * The rakeback settler asked fn_union_eco_record_current_week to persist the
 * union ECO (win tax / loss rebate) for the week in progress, every cycle.
 * Since 2026-09-17 fn_union_eco_record proves the union's P&L evidence first
 * (fn_require_union_pnl_evidence), and that proof admits only a CLOSED week, so
 * the open-week call was refused with invalid_closed_pnl_evidence_period three
 * times an hour for twenty-five days and wrote nothing. The closed week is
 * recorded once, at close, by fn_union_settlement_cascade, and the governance
 * sentinel asks only about closed weeks.
 *
 * The settler therefore never asks for the open week again; the closed-week
 * writer is untouched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SETTLER = code(read('server/src/services/RakebackSettlerService.ts'));

describe('an open week has no ECO to record', () => {
  it('the settler never calls the open-week ECO recorder', () => {
    expect(SETTLER).not.toMatch(/fn_union_eco_record_current_week/);
    expect(SETTLER).not.toMatch(/runUnionEcoRecord/);
  });

  it('the settler still runs the sentinel that checks the closed week was recorded', () => {
    expect(SETTLER).toMatch(/await this\.runUnionGovernanceSentinel\(\)/);
    expect(SETTLER).toMatch(/fn_union_governance_check/);
  });
});
