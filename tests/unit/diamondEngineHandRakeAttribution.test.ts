import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const proof = resolve('tests/sql/run-diamond-engine-hand-proof.py');
const player = (id: string, contributed: number) => ({ user_id: id, contributed });
function oracle(elements: unknown[], rake: number) {
  const result = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      'import json,runpy,sys\nf=runpy.run_path(sys.argv[1])["expected_rake_shares"]\nv=json.load(sys.stdin)\nprint(json.dumps(f(v["elements"],v["rake"])))',
      proof,
    ],
    {
      input: JSON.stringify({ elements, rake }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
describe('Diamond real-hand qualification exact rake attribution', () => {
  it('allows a contributing horse zero indivisible share without excluding it from the oracle', () => {
    expect(oracle([player('a', 19), player('horse', 1)], 1)).toEqual([{ user_id: 'a', amount: 1 }]);
    expect(oracle([player('a', 1), player('horse', 19)], 1)).toEqual([
      { user_id: 'horse', amount: 1 },
    ]);
  });
  it('distributes the remainder by weight then user identity, independently of payload order', () => {
    expect(oracle([player('c', 1), player('b', 1), player('a', 1)], 2)).toEqual([
      { user_id: 'a', amount: 1 },
      { user_id: 'b', amount: 1 },
    ]);
    expect(oracle([player('a', 10), player('horse', 20), player('c', 0)], 8)).toEqual([
      { user_id: 'a', amount: 3 },
      { user_id: 'horse', amount: 5 },
    ]);
    expect(oracle([player('a', 10), player('horse', 20)], 0)).toEqual([]);
  });
  it('retains actual full-row comparison rather than only testing horse positivity or total conservation', () => {
    const source = readFileSync(proof, 'utf8');
    expect(source).toContain('if actual_shares != expected_shares:');
    expect(source).toContain("AND kind='rake'");
    expect(source).not.toContain('AND amount > 0)');
  });
});
