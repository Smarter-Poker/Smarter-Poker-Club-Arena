import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const tablePage = readFileSync('src/pages/TablePage.tsx', 'utf8');

function functionWindow(start: string, end: string): string {
  const from = tablePage.indexOf(start);
  const to = tablePage.indexOf(end, from + start.length);
  expect(from, `${start} was not found`).toBeGreaterThan(-1);
  expect(to, `${end} was not found after ${start}`).toBeGreaterThan(from);
  return tablePage.slice(from, to);
}

describe('Insurance human-path recovery', () => {
  it('does not hide the offer before an accepted purchase succeeds', () => {
    const body = functionWindow('const handleInsuranceAccept = async', '// FIX 89: "Decline Now"');
    const request = body.indexOf('await respondToInsurance');
    const failure = body.indexOf('if (!result.success)');
    const close = body.indexOf('setShowInsurance(false)');
    expect(request).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(request);
    expect(close).toBeGreaterThan(failure);
    expect(body.slice(failure, close)).toMatch(/toast\?\.error/);
    expect(body.slice(failure, close)).toMatch(/return false/);
  });

  it('does not hide EV cashout before the server accepts it either', () => {
    const body = functionWindow('const handleInsuranceEvCashout = async', '// A decline is final:');
    const request = body.indexOf("await respondToInsurance(tableId, 'cashout')");
    const failure = body.indexOf('if (!result.success)');
    const close = body.indexOf('setShowInsurance(false)');
    expect(request).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(request);
    expect(close).toBeGreaterThan(failure);
    expect(body.slice(failure, close)).toMatch(/return false/);
  });
});
