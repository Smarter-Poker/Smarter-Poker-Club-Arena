import { createHash } from 'node:crypto';
import { riverPublicNode } from '../HorseMultiwayRiverRead.js';
import {
  makeOwnPublicHistoryPacket,
  type HorseOwnPublicHistoryWindow,
} from './ownPublicHistory.js';
export const HORSE_RIVER_NODE_DEFINITION_MD5 = 'eb122b43bfd7680a96adb796cd0c1221';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).length === fields.length && fields.every((k) => Object.hasOwn(v, k));
export function riverNodeBindings(window: HorseOwnPublicHistoryWindow) {
  return window.hands.map((h) => ({
    handId: h.handId,
    actions: h.actions,
    binding: createHash('sha256').update(JSON.stringify(h.actions)).digest('hex'),
  }));
}
/** All-or-nothing bounded enrichment. Unknown never removes the original public history. */
export function attachRiverNodeSidecar(
  window: HorseOwnPublicHistoryWindow,
  data: unknown,
  at: number
): { window: HorseOwnPublicHistoryWindow; status: 'captured' | 'unavailable' } {
  const unavailable = () => ({ window, status: 'unavailable' as const });
  if (
    !object(data) ||
    !exact(data, ['version', 'status', 'hands', 'definitionMd5']) ||
    data.definitionMd5 !== HORSE_RIVER_NODE_DEFINITION_MD5 ||
    data.version !== 1 ||
    data.status !== 'captured' ||
    !Array.isArray(data.hands) ||
    data.hands.length !== window.hands.length
  )
    return unavailable();
  const bindings = riverNodeBindings(window);
  const copy = structuredClone(window);
  const seen = new Set<string>();
  for (const raw of data.hands) {
    if (!object(raw) || typeof raw.handId !== 'string' || seen.has(raw.handId))
      return unavailable();
    seen.add(raw.handId);
    const binding = bindings.find((b) => b.handId === raw.handId);
    const hand = copy.hands.find((h) => h.handId === raw.handId);
    if (!binding || !hand || raw.binding !== binding.binding) return unavailable();
    hand.riverNodeEvidence = 'unavailable';
    if (raw.status === 'unavailable') {
      if (
        !exact(raw, ['handId', 'binding', 'status', 'reason']) ||
        ![
          'original_context_unavailable',
          'action_binding_mismatch',
          'incomplete_or_bounded_nodes',
        ].includes(String(raw.reason))
      )
        return unavailable();
      continue;
    }
    if (
      raw.status !== 'captured' ||
      !exact(raw, ['handId', 'binding', 'status', 'nodes']) ||
      !Array.isArray(raw.nodes) ||
      ![2, 4].includes(raw.nodes.length)
    )
      return unavailable();
    const ordinals = hand.actions
      .flatMap((a, i) =>
        a.stage === 'river' &&
        ['fold', 'check', 'call', 'bet', 'raise', 'all_in'].includes(a.action)
          ? [i]
          : []
      )
      .slice(0, raw.nodes.length);
    const nodes = raw.nodes.map((r, i) =>
      object(r) && exact(r, ['ordinal', 'node']) && r.ordinal === ordinals[i]
        ? riverPublicNode(r.node)
        : null
    );
    // Bad or missing snapshots cannot poison the valid original action window.
    if (nodes.some((n) => !n) || ordinals.length !== raw.nodes.length) continue;
    for (let i = 0; i < raw.nodes.length; i++) {
      if (
        nodes[i]!.actorSeat !== hand.actions[ordinals[i]].seat ||
        nodes[i]!.variant !== hand.variant ||
        nodes[i]!.bigBlind !== hand.bigBlind
      )
        return unavailable();
      hand.actions[ordinals[i]].publicNode = nodes[i]!;
    }
    hand.riverNodeEvidence = 'captured';
  }
  if (!makeOwnPublicHistoryPacket(copy, at)) return unavailable();
  return { window: copy, status: 'captured' };
}
