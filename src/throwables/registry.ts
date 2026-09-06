/**
 * THE RIG REGISTRY — which throwables play through ThrowablePlayer.
 *
 * An item is here when it has a spec and a rig built to the reference beats
 * (docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md section 4). Everything
 * not here still plays through the legacy ThrowAnimation, one rig at a time
 * until phase 4 deletes it. The id is the catalogue id and the wire id; the
 * registry never renames.
 */

import type { ThrowableSpec } from './spec';
import type { ThrowableRig } from './rig';
import { beerSpec, beerRig } from './rigs/beer';
import { champagneSpec, champagneRig } from './rigs/champagne';
import { crackedEggSpec, crackedEggRig } from './rigs/cracked_egg';
import { fireworksSpec, fireworksRig } from './rigs/fireworks';
import { roseSpec, roseRig } from './rigs/rose';
import { tomatoSpec, tomatoRig } from './rigs/tomato';
import { waterGunSpec, waterGunRig } from './rigs/water_gun';

export interface RiggedThrowable {
  spec: ThrowableSpec;
  rig: ThrowableRig;
}

const RIGGED: Record<string, RiggedThrowable> = {
  beer: { spec: beerSpec, rig: beerRig },
  champagne: { spec: champagneSpec, rig: champagneRig },
  cracked_egg: { spec: crackedEggSpec, rig: crackedEggRig },
  fireworks: { spec: fireworksSpec, rig: fireworksRig },
  rose: { spec: roseSpec, rig: roseRig },
  tomato: { spec: tomatoSpec, rig: tomatoRig },
  water_gun: { spec: waterGunSpec, rig: waterGunRig },
};

export const RIGGED_IDS: readonly string[] = Object.keys(RIGGED);

export function riggedThrowable(id: string): RiggedThrowable | undefined {
  return RIGGED[id];
}

export function hasRig(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(RIGGED, id);
}

export function allSpecs(): ThrowableSpec[] {
  return Object.values(RIGGED).map((r) => r.spec);
}
