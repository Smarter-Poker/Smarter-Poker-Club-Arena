import { public215CacheMetadataJson } from './buildPublicHist215Features.js';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  public215RangeUnits,
  public215AllowedCombos,
  public215NpyHeader,
  assemblePublic215Cached,
  assertPublic215CacheBinding,
  validPublic215SourceNode,
} from './buildPublicHist215Features.js';
import {
  compilePublic215Template,
  encodePublic215Base181,
  encodePublic215State28,
  type Public215Template,
} from '../engine/GtoPublicHist215Features.js';
import { public215Digest } from '../engine/GtoPublicHist215Model.js';
const hex = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b.toString('hex');
};
function compiled() {
  const wire: Public215Template = {
    format: 'public_hist215_template_v1',
    root_actor: 'IP',
    context: {
      depth_bucket: 80,
      table_size: 2,
      game_family: 'cash',
      objective: 'cash_ev',
      utility_context: 'cash_ev',
      pot_type: 'srp',
      hero_position: 'BTN',
      opponent_position: 'BB',
      street: 'flop',
      texture_class: 'Brud',
      node_role: 'cbet',
      facing_kind: 'none',
      facing_size_bucket: 'none',
    },
    scenario: {
      pot_chips_f64: hex(60),
      effective_stack_chips_f64: hex(800),
      chips_per_bb_f64: hex(10),
      rake_f64: [hex(5), hex(3)],
      ip_range_checksum: '01b3d4e721b36cf6d8d89fd4941b5ece0e9fd2853f61d1e5f98fbebb3f8f5228',
      oop_range_checksum: '3ac1e6fa6d92a000680addaf06eab130d2af9467d2e90aceae7cb542b8725c11',
    },
    opponent_weights: Array(1326).fill('1'),
  };
  return compilePublic215Template(wire, public215Digest(wire));
}
describe('finite public215 batch source boundaries', () => {
  it('parses exact decimal 1e12 units without binary64 multiplication', () => {
    const values = Array(1326).fill('0');
    values[0] = '1e-12';
    values[1] = '0.1';
    values[2] = '1.000000000000';
    expect(public215RangeUnits('[' + values.join(',') + ']').slice(0, 3)).toEqual([
      1n,
      100000000000n,
      1000000000000n,
    ]);
    for (const token of ['1e-13', '-0.1', '1.000000000001', 'NaN', '"1"']) {
      const bad = [...values];
      bad[0] = token;
      expect(() => public215RangeUnits(bad.join(' '))).toThrow();
    }
    expect(() => public215RangeUnits('1 1')).toThrow('CENSUS');
  });
  it('requires own-positive, board-unblocked and disjoint opponent support in canonical combo order', () => {
    const own = Array(1326).fill(0n),
      opponent = Array(1326).fill(0n);
    own[0] = 1n;
    own[5] = 1n;
    own[1325] = 1n;
    opponent[0] = 1n;
    // combo0=2c2d; combo5=2h2s; combo1325=AhAs.
    expect(public215AllowedCombos(own, opponent, '3c7dTh')).toEqual([5, 1325]);
    expect(public215AllowedCombos(own, opponent, '2c7dTh')).toEqual([]);
  });
  it('writes a standard NumPy v1 little-endian exact frame independently readable by Python stdlib', () => {
    const header = public215NpyHeader(1),
      data = Buffer.alloc(215 * 8);
    data.writeDoubleLE(-0, 0);
    data.writeDoubleLE(Number.MIN_VALUE, 8);
    const script =
      "import sys,base64,struct,ast; b=base64.b64decode(sys.stdin.buffer.read()); assert b[:8]==b'\\x93NUMPY\\x01\\x00'; n=struct.unpack('<H',b[8:10])[0]; h=ast.literal_eval(b[10:10+n].decode()); assert h=={'descr':'<f8','fortran_order':False,'shape':(1,215)}; assert len(b)==10+n+215*8; assert b[10+n:26+n].hex()=='00000000000000800100000000000000'; print('ok')";
    const result = spawnSync('python3', ['-B', '-c', script], {
      input: Buffer.concat([header, data]).toString('base64'),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    for (const n of [0, -1, 57 * 1326 + 1]) expect(() => public215NpyHeader(n)).toThrow();
  });
  it('appends cached six physics columns between unchanged181 and state28, without native calls', () => {
    const t = compiled(),
      own = ['Ac', 'Kd'],
      board = '2c7dTh',
      current = [0.25, 0.25, 0.5],
      terminal = [0.125, 0.375, 0.5];
    const actual = assemblePublic215Cached(own, board, t, current, terminal);
    expect(actual.slice(0, 181)).toEqual(encodePublic215Base181(own, board.match(/../g)!, t));
    expect(actual.slice(181, 187)).toEqual([...current, ...terminal]);
    expect(actual.slice(187)).toEqual(encodePublic215State28(own, board.match(/../g)!));
    for (const invalid of [null, [0.2, 0.2, 0.2], [NaN, 0, 1]])
      expect(() => assemblePublic215Cached(own, board, t, invalid, terminal)).toThrow();
  });
  it('retains explicit chronological card tokens in turn and river Pio node paths', () => {
    for (const node of ['r:0', 'r:0:c:b250:c:2h:c', 'r:0:c:c:2h:c:c:Js'])
      expect(validPublic215SourceNode(node)).toBe(true);
    for (const node of ['r:0:x', 'r:0:c:1h', 'r:0:c:As:bad'])
      expect(validPublic215SourceNode(node)).toBe(false);
  });
  it('refuses semantic cache relabeling across context, chronology, actor or ROOT opponent range', () => {
    const t = compiled(),
      cid = public215Digest(t.context),
      target = { board: '2c7dTh' },
      row = {
        context_id: cid,
        board: target.board,
        actor: 1,
        opponent_solver_player: 'OOP',
        opponent_range_sha256: t.oopRangeChecksum,
      };
    expect(() => assertPublic215CacheBinding(row, target, cid, t)).not.toThrow();
    for (const changed of [
      { context_id: 'a'.repeat(64) },
      { board: '2cTh7d' },
      { actor: 0 },
      { opponent_solver_player: 'IP' },
      { opponent_range_sha256: t.ipRangeChecksum },
    ])
      expect(() => assertPublic215CacheBinding({ ...row, ...changed }, target, cid, t)).toThrow();
  });
});

it('preserves multiline compiler ancestry without relaxing numeric model JSON', () => {
  expect(public215CacheMetadataJson({ compiler: { version: 'clang\nTarget: arm64' } })).toBe(
    '{"compiler":{"version":"clang\\nTarget: arm64"}}'
  );
  expect(public215CacheMetadataJson({ b: 2, a: 'x' })).toBe(
    public215CacheMetadataJson({ a: 'x', b: 2 })
  );
  expect(() => public215CacheMetadataJson({ x: 0.5 })).toThrow();
});
