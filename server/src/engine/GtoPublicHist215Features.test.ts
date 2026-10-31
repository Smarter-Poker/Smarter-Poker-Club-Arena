import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  compilePublic215Template,
  encodePublic215Base181,
  encodePublic215State28,
  encodePublic215Features,
  public215TemplateMatchesContext,
  type Public215Template,
} from './GtoPublicHist215Features.js';
import { public215Digest } from './GtoPublicHist215Model.js';
const hex = (n: number) => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, n, false);
  return v.getBigUint64(0, false).toString(16).padStart(16, '0');
};
function wire(): Public215Template {
  return {
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
}
const compiled = () => {
  const w = wire();
  return compilePublic215Template(w, public215Digest(w));
};
describe('public215 immutable template and public feature boundary', () => {
  it('decodes exact authored geometry and binds every context field', () => {
    const t = compiled();
    expect(t.potBb).toBe(6);
    expect(t.stackBb).toBe(80);
    expect(public215TemplateMatchesContext(t, t.context)).toBe(true);
    expect(public215TemplateMatchesContext(t, { ...t.context, depth_bucket: 81 })).toBe(false);
    expect(Object.isFrozen(t.context)).toBe(true);
  });
  it('requires exact metadata, known categories, bounded integer range and positive geometry', () => {
    for (const change of [
      (w: any) => (w.scenario.extra = 1),
      (w: any) => (w.context.node_role = 'unknown'),
      (w: any) => (w.opponent_weights[0] = '01'),
      (w: any) => w.opponent_weights.fill('0'),
      (w: any) => (w.opponent_weights[0] = '9223372036854775807'),
      (w: any) => (w.scenario.chips_per_bb_f64 = hex(0)),
    ]) {
      const w = wire();
      change(w);
      expect(() => compilePublic215Template(w, public215Digest(w))).toThrow();
    }
  });
  it('retains the fixed 181 prefix shape and canonical graph state without hidden cards', () => {
    const t = compiled(),
      h = ['Ac', 'Kd'],
      b = ['2c', '7d', 'Th'];
    const f = encodePublic215Base181(h, b, t);
    expect(f).toHaveLength(181);
    expect(f.every(Number.isFinite)).toBe(true);
    expect(createHash('sha256').update(JSON.stringify(f)).digest('hex')).toBe(
      'e421408f1934d8e45a8657a4dff9e4dbe73582e315396d5f958a0f4dd8c448ea'
    );
    const s = encodePublic215State28(h, b);
    expect(s.slice(0, 7)).toEqual([14, 13, 10, 7, 2, 0, 0]);
    expect(s).toHaveLength(28);
    expect(encodePublic215State28(['Ad', 'Kh'], ['2d', '7h', 'Tc'])).toEqual(s);
    expect(() => encodePublic215Base181(h, [...b, 'Ac'], t)).toThrow();
    expect(() => encodePublic215Base181(h, [...b, '3s'], t)).toThrow('STREET_CARD_COUNT');
  });
  it('refuses native feature computation on the main thread before loading or invoking native', () => {
    expect(() => encodePublic215Features(['Ac', 'Kd'], ['2c', '7d', 'Th'], compiled())).toThrow(
      'TABLE_FIFO_WORKER_REQUIRED'
    );
  });
});
