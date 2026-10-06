import type { Page } from '@playwright/test';

type AxeNode = { target: unknown[] };
type AxeViolation = { id: string; nodes: AxeNode[] };

/**
 * THE ONE WRITTEN AXE EXCEPTION, IN ONE PLACE (2026-10-01).
 *
 * On an iPhone browser a tap target that should buzz carries TapHaptic: an
 * invisible native switch INSIDE the button, aria-hidden and out of the tab
 * order, because the finger has to land on it while the click still reaches
 * the button (src/components/haptics/TapHaptic.tsx explains why there is no
 * other way). axe reports that as `nested-interactive`. Since pop-up plates
 * carry the switch too, every axe check of a pop-up on an iPhone profile meets
 * it. This removes exactly those nodes, a button whose direct child is the
 * tap switch, and nothing else: any other nested control, and every other
 * violation, still fails.
 */
export async function withoutTapSwitchNesting<V extends AxeViolation>(
  page: Page,
  violations: V[]
): Promise<V[]> {
  const kept: V[] = [];
  for (const violation of violations) {
    if (violation.id !== 'nested-interactive') {
      kept.push(violation);
      continue;
    }
    const nodes: AxeNode[] = [];
    for (const node of violation.nodes) {
      const selector = String(node.target[node.target.length - 1]);
      const isTapSwitch = await page.evaluate(
        (s) => Boolean(document.querySelector(`${s} > input[data-tap-haptic]`)),
        selector
      );
      if (!isTapSwitch) nodes.push(node);
    }
    if (nodes.length) kept.push({ ...violation, nodes });
  }
  return kept;
}
