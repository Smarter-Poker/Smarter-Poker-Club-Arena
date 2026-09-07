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
import { bananaPeelSpec, bananaPeelRig } from './rigs/banana_peel';
import { beerSpec, beerRig } from './rigs/beer';
import { cakeSpec, cakeRig } from './rigs/cake';
import { cashStackSpec, cashStackRig } from './rigs/cash_stack';
import { champagneSpec, champagneRig } from './rigs/champagne';
import { crackedEggSpec, crackedEggRig } from './rigs/cracked_egg';
import { diceSpec, diceRig } from './rigs/dice';
import { fireworksSpec, fireworksRig } from './rigs/fireworks';
import { horseshoeSpec, horseshoeRig } from './rigs/horseshoe';
import { roseSpec, roseRig } from './rigs/rose';
import { snowmanSpec, snowmanRig } from './rigs/snowman';
import { tomatoSpec, tomatoRig } from './rigs/tomato';
import { trashCanSpec, trashCanRig } from './rigs/trash_can';
import { trophySpec, trophyRig } from './rigs/trophy';
import { waterGunSpec, waterGunRig } from './rigs/water_gun';

export interface RiggedThrowable {
  spec: ThrowableSpec;
  rig: ThrowableRig;
}

const RIGGED: Record<string, RiggedThrowable> = {
  banana_peel: { spec: bananaPeelSpec, rig: bananaPeelRig },
  beer: { spec: beerSpec, rig: beerRig },
  cake: { spec: cakeSpec, rig: cakeRig },
  cash_stack: { spec: cashStackSpec, rig: cashStackRig },
  champagne: { spec: champagneSpec, rig: champagneRig },
  cracked_egg: { spec: crackedEggSpec, rig: crackedEggRig },
  dice: { spec: diceSpec, rig: diceRig },
  fireworks: { spec: fireworksSpec, rig: fireworksRig },
  horseshoe: { spec: horseshoeSpec, rig: horseshoeRig },
  rose: { spec: roseSpec, rig: roseRig },
  snowman: { spec: snowmanSpec, rig: snowmanRig },
  tomato: { spec: tomatoSpec, rig: tomatoRig },
  trash_can: { spec: trashCanSpec, rig: trashCanRig },
  trophy: { spec: trophySpec, rig: trophyRig },
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
