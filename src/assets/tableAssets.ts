/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  tableAssets — the real table skins and backgrounds, in one place
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-18: "the themes and tables should show the actual theme and
 * table layouts not just a color."
 *
 * These two registries used to live inside TablePage.tsx, which meant the only
 * thing that could see them was the table itself. The Theme Settings picker,
 * sitting in a different component, had no way to reach the artwork - so every
 * option in it was a hand-written CSS gradient "approximating each composite's
 * palette" (its own words). You picked a table by looking at a colour smear
 * and hoped.
 *
 * Extracted verbatim so both the felt and the picker read the SAME source. A
 * new skin now shows up in the picker automatically instead of needing a
 * matching gradient invented for it.
 *
 * Aliases keep older stored table_id / background_id values working; they are
 * intentionally included in the maps but filtered out of the *_IDS lists below
 * so the picker shows each design exactly once.
 */

import skinClassicGreen from '../assets/tables/skin_classic_green.png';
import skinOceanBlue from '../assets/tables/skin_ocean_blue.png';
import skinCrimson from '../assets/tables/skin_crimson.png';
import skinElectricPurple from '../assets/tables/skin_electric_purple.png';
import skinGoldenSand from '../assets/tables/skin_golden_sand.png';
import skinNeonCity from '../assets/tables/skin_neon_city.png';
import skinIceCavern from '../assets/tables/skin_ice_cavern.png';
import skinCarbonRed from '../assets/tables/skin_carbon_red.png';
import skinArcticWhite from '../assets/tables/skin_arctic_white.png';
import skinMahoganyRed from '../assets/tables/skin_mahogany_red.png';
import skinAmethystCavern from '../assets/tables/skin_amethyst_cavern.png';
import skinCarbonIon from '../assets/tables/skin_carbon_ion.png';
import skinJadeCity from '../assets/tables/skin_jade_city.png';

import bgMidnight from '../assets/backgrounds/bg_midnight.jpg';
import bgRoyalIndigo from '../assets/backgrounds/bg_royal_indigo.jpg';
import bgEmeraldRoom from '../assets/backgrounds/bg_emerald_room.jpg';
import bgCrimsonLounge from '../assets/backgrounds/bg_crimson_lounge.jpg';
import bgOceanAbyss from '../assets/backgrounds/bg_ocean_abyss.jpg';
import bgGoldenDusk from '../assets/backgrounds/bg_golden_dusk.jpg';
import bgGalaxy from '../assets/backgrounds/bg_galaxy.jpg';
import bgCarbonGrid from '../assets/backgrounds/bg_carbon_grid.jpg';
import bgIceFrost from '../assets/backgrounds/bg_ice_frost.jpg';
import bgJadeNeon from '../assets/backgrounds/bg_jade_neon.jpg';

export const TABLE_SKINS: Record<string, string> = {
  classic_green: skinClassicGreen,
  'classic-green': skinClassicGreen,
  ocean_blue: skinOceanBlue,
  'royal-blue': skinOceanBlue,
  crimson: skinCrimson,
  'wine-red': skinCrimson,
  electric_purple: skinElectricPurple,
  'purple-haze': skinElectricPurple,
  golden_sand: skinGoldenSand,
  emerald: skinGoldenSand,
  neon_city: skinNeonCity,
  ice_cavern: skinIceCavern,
  carbon_red: skinCarbonRed,
  arctic_white: skinArcticWhite,
  mahogany_red: skinMahoganyRed,
  amethyst_cavern: skinAmethystCavern,
  carbon_ion: skinCarbonIon,
  jade_city: skinJadeCity,
  // Legacy ThemeSettingsModal ids (pre-2026-08-17 the modal's table list
  // never matched the skin switch, so these all silently fell back to
  // green). Map each to the closest real skin so old saved rows upgrade.
  'brown-felt': skinMahoganyRed,
  'neon-blue-felt': skinOceanBlue,
  'red-leather': skinCrimson,
  'green-casino': skinClassicGreen,
  'dark-felt': skinNeonCity,
};

export const TABLE_BACKGROUNDS: Record<string, string> = {
  midnight: bgMidnight,
  royal_indigo: bgRoyalIndigo,
  emerald_room: bgEmeraldRoom,
  crimson_lounge: bgCrimsonLounge,
  ocean_abyss: bgOceanAbyss,
  golden_dusk: bgGoldenDusk,
  galaxy: bgGalaxy,
  carbon_grid: bgCarbonGrid,
  ice_frost: bgIceFrost,
  jade_neon: bgJadeNeon,
  // Legacy ids saved before 2026-08-18
  'diamond-pattern': bgMidnight,
  'stone-concrete': bgCarbonGrid,
  'galaxy-nebula': bgGalaxy,
  'hardwood-floor': bgGoldenDusk,
  'teal-tile': bgJadeNeon,
};

/** Canonical ids, in display order, with legacy aliases removed. */
export const TABLE_SKIN_IDS: string[] = [
  'classic_green',
  'ocean_blue',
  'crimson',
  'electric_purple',
  'golden_sand',
  'neon_city',
  'ice_cavern',
  'carbon_red',
  'arctic_white',
  'mahogany_red',
  'amethyst_cavern',
  'carbon_ion',
  'jade_city',
];

export const TABLE_BACKGROUND_IDS: string[] = [
  'midnight',
  'royal_indigo',
  'emerald_room',
  'crimson_lounge',
  'ocean_abyss',
  'golden_dusk',
  'galaxy',
  'carbon_grid',
  'ice_frost',
  'jade_neon',
];
