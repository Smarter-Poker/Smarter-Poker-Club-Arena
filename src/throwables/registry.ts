import { spec as fishSpec, rig as fishRig } from './rigs/fish';
import { spec as magic_8_ballSpec, rig as magic_8_ballRig } from './rigs/magic_8_ball';
import { spec as lightning_boltSpec, rig as lightning_boltRig } from './rigs/lightning_bolt';
import { spec as skullSpec, rig as skullRig } from './rigs/skull';
import { spec as ufoSpec, rig as ufoRig } from './rigs/ufo';
import { spec as ghostSpec, rig as ghostRig } from './rigs/ghost';
import { spec as anvilSpec, rig as anvilRig } from './rigs/anvil';
import { spec as sharkSpec, rig as sharkRig } from './rigs/shark';
import { spec as bearSpec, rig as bearRig } from './rigs/bear';
import { spec as pizzaSliceSpec, rig as pizzaSliceRig } from './rigs/pizza_slice';
import { spec as chickenSpec, rig as chickenRig } from './rigs/chicken';
import { spec as dogeSpec, rig as dogeRig } from './rigs/doge';
import { spec as cryingemojiSpec, rig as cryingemojiRig } from './rigs/crying_emoji';
import { spec as laughingemojiSpec, rig as laughingemojiRig } from './rigs/laughing_emoji';
import { spec as angryemojiSpec, rig as angryemojiRig } from './rigs/angry_emoji';
import { spec as heartSpec, rig as heartRig } from './rigs/heart';
import {
  spec as coolsunglassesemojiSpec,
  rig as coolsunglassesemojiRig,
} from './rigs/cool_sunglasses_emoji';
import { spec as magnetSpec, rig as magnetRig } from './rigs/magnet';
import { spec as coffeeSpec, rig as coffeeRig } from './rigs/coffee';
import { spec as bowlingballSpec, rig as bowlingballRig } from './rigs/bowling_ball';
import { spec as tennisballSpec, rig as tennisballRig } from './rigs/tennis_ball';
import { spec as footballSpec, rig as footballRig } from './rigs/football';
import { spec as basketballSpec, rig as basketballRig } from './rigs/basketball';
import { spec as diamondSpec, rig as diamondRig } from './rigs/diamond';
import { spec as starSpec, rig as starRig } from './rigs/star';
import { spec as thumbsdownSpec, rig as thumbsdownRig } from './rigs/thumbs_down';
import { spec as thumbsupSpec, rig as thumbsupRig } from './rigs/thumbs_up';
import { rubberDuckSpec, rubberDuckRig } from './rigs/rubber_duck';
/**
 * THE RIG REGISTRY — which throwables play through ThrowablePlayer.
 *
 * An item is here when it has a spec and a rig built to the reference beats
 * (docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md section 4). Everything
 * not here still plays through the legacy ThrowAnimation, one rig at a time
 * until phase 4 deletes it. The id is the catalogue id and the wire id; the
 * registry never renames.
 */

import { alienSpec, alienRig } from './rigs/alien';
import { robotSpec, robotRig } from './rigs/robot';
import type { ThrowableSpec } from './spec';
import type { ThrowableRig } from './rig';
import { bananaPeelSpec, bananaPeelRig } from './rigs/banana_peel';
import { beerSpec, beerRig } from './rigs/beer';
import { bombSpec, bombRig } from './rigs/bomb';
import { cakeSpec, cakeRig } from './rigs/cake';
import { cashStackSpec, cashStackRig } from './rigs/cash_stack';
import { champagneSpec, champagneRig } from './rigs/champagne';
import { crackedEggSpec, crackedEggRig } from './rigs/cracked_egg';
import { diceSpec, diceRig } from './rigs/dice';
import { fireworksSpec, fireworksRig } from './rigs/fireworks';
import { horseshoeSpec, horseshoeRig } from './rigs/horseshoe';
import { poopSpec, poopRig } from './rigs/poop';
import { rocketSpec, rocketRig } from './rigs/rocket';
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
  fish: { spec: fishSpec, rig: fishRig },
  magic_8_ball: { spec: magic_8_ballSpec, rig: magic_8_ballRig },
  lightning_bolt: { spec: lightning_boltSpec, rig: lightning_boltRig },
  skull: { spec: skullSpec, rig: skullRig },
  ufo: { spec: ufoSpec, rig: ufoRig },
  ghost: { spec: ghostSpec, rig: ghostRig },
  anvil: { spec: anvilSpec, rig: anvilRig },
  shark: { spec: sharkSpec, rig: sharkRig },
  bear: { spec: bearSpec, rig: bearRig },
  pizza_slice: { spec: pizzaSliceSpec, rig: pizzaSliceRig },
  chicken: { spec: chickenSpec, rig: chickenRig },
  doge: { spec: dogeSpec, rig: dogeRig },
  crying_emoji: { spec: cryingemojiSpec, rig: cryingemojiRig },
  laughing_emoji: { spec: laughingemojiSpec, rig: laughingemojiRig },
  angry_emoji: { spec: angryemojiSpec, rig: angryemojiRig },
  heart: { spec: heartSpec, rig: heartRig },
  cool_sunglasses_emoji: { spec: coolsunglassesemojiSpec, rig: coolsunglassesemojiRig },
  rubber_duck: { spec: rubberDuckSpec, rig: rubberDuckRig },
  thumbs_up: { spec: thumbsupSpec, rig: thumbsupRig },
  thumbs_down: { spec: thumbsdownSpec, rig: thumbsdownRig },
  star: { spec: starSpec, rig: starRig },
  diamond: { spec: diamondSpec, rig: diamondRig },
  basketball: { spec: basketballSpec, rig: basketballRig },
  football: { spec: footballSpec, rig: footballRig },
  tennis_ball: { spec: tennisballSpec, rig: tennisballRig },
  bowling_ball: { spec: bowlingballSpec, rig: bowlingballRig },
  coffee: { spec: coffeeSpec, rig: coffeeRig },
  magnet: { spec: magnetSpec, rig: magnetRig },
  alien: { spec: alienSpec, rig: alienRig },
  robot: { spec: robotSpec, rig: robotRig },
  banana_peel: { spec: bananaPeelSpec, rig: bananaPeelRig },
  beer: { spec: beerSpec, rig: beerRig },
  bomb: { spec: bombSpec, rig: bombRig },
  cake: { spec: cakeSpec, rig: cakeRig },
  cash_stack: { spec: cashStackSpec, rig: cashStackRig },
  champagne: { spec: champagneSpec, rig: champagneRig },
  cracked_egg: { spec: crackedEggSpec, rig: crackedEggRig },
  dice: { spec: diceSpec, rig: diceRig },
  fireworks: { spec: fireworksSpec, rig: fireworksRig },
  horseshoe: { spec: horseshoeSpec, rig: horseshoeRig },
  poop: { spec: poopSpec, rig: poopRig },
  rocket: { spec: rocketSpec, rig: rocketRig },
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
