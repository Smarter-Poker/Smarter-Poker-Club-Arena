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
import skinFinalTable from '../assets/tables/skin_final_table.png';

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
import bgPlaceLasVegas from '../assets/backgrounds/bg_place_las_vegas.jpg';
import bgPlaceParis from '../assets/backgrounds/bg_place_paris.jpg';
import bgPlaceLondon from '../assets/backgrounds/bg_place_london.jpg';
import bgPlaceTokyo from '../assets/backgrounds/bg_place_tokyo.jpg';
import bgPlaceDubai from '../assets/backgrounds/bg_place_dubai.jpg';
import bgPlaceSydney from '../assets/backgrounds/bg_place_sydney.jpg';
import bgPlaceRio from '../assets/backgrounds/bg_place_rio.jpg';
import bgPlaceSantorini from '../assets/backgrounds/bg_place_santorini.jpg';
import bgPlaceNewYork from '../assets/backgrounds/bg_place_new_york.jpg';
import bgPlaceMonaco from '../assets/backgrounds/bg_place_monaco.jpg';
import bgSkinShadowSuits from '../assets/backgrounds/bg_skin_shadow_suits.jpg';
import bgSkinGildedFall from '../assets/backgrounds/bg_skin_gilded_fall.jpg';
import bgSkinCrimsonDamask from '../assets/backgrounds/bg_skin_crimson_damask.jpg';
import bgSkinGraphiteEmbossed from '../assets/backgrounds/bg_skin_graphite_embossed.jpg';
import bgSkinObsidianMicro from '../assets/backgrounds/bg_skin_obsidian_micro.jpg';
import bgSkinEmeraldArgyle from '../assets/backgrounds/bg_skin_emerald_argyle.jpg';
import bgSkinUltravioletSuits from '../assets/backgrounds/bg_skin_ultraviolet_suits.jpg';
import bgSkinBlackGoldChips from '../assets/backgrounds/bg_skin_black_gold_chips.jpg';
import bgSkinGoldenSparks from '../assets/backgrounds/bg_skin_golden_sparks.jpg';
import bgSkinPlatinumDeco from '../assets/backgrounds/bg_skin_platinum_deco.jpg';
import bgFinalTableBroadcast from '../assets/backgrounds/bg_final_table_broadcast.jpg';

const tableThumbnailModules = import.meta.glob('./customization-thumbs/tables/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const backgroundThumbnailModules = import.meta.glob('./customization-thumbs/backgrounds/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function thumbnail(modules: Record<string, string>, directory: string, file: string): string {
  return modules[`./customization-thumbs/${directory}/${file}.webp`] || '';
}

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
  // Event-only broadcast skin; excluded from TABLE_SKIN_IDS because it is
  // activated automatically by the MTT milestone, not manually selected.
  final_table: skinFinalTable,
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
  // Event-only arena paired with the Final Table skin. It is intentionally
  // absent from TABLE_BACKGROUND_IDS: game state activates it, not the picker.
  final_table_broadcast: bgFinalTableBroadcast,
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
  place_las_vegas: bgPlaceLasVegas,
  place_paris: bgPlaceParis,
  place_london: bgPlaceLondon,
  place_tokyo: bgPlaceTokyo,
  place_dubai: bgPlaceDubai,
  place_sydney: bgPlaceSydney,
  place_rio: bgPlaceRio,
  place_santorini: bgPlaceSantorini,
  place_new_york: bgPlaceNewYork,
  place_monaco: bgPlaceMonaco,
  skin_shadow_suits: bgSkinShadowSuits,
  skin_gilded_fall: bgSkinGildedFall,
  skin_crimson_damask: bgSkinCrimsonDamask,
  skin_graphite_embossed: bgSkinGraphiteEmbossed,
  skin_obsidian_micro: bgSkinObsidianMicro,
  skin_emerald_argyle: bgSkinEmeraldArgyle,
  skin_ultraviolet_suits: bgSkinUltravioletSuits,
  skin_black_gold_chips: bgSkinBlackGoldChips,
  skin_golden_sparks: bgSkinGoldenSparks,
  skin_platinum_deco: bgSkinPlatinumDeco,
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

/** Real skins controlled by game state rather than the cosmetic picker. */
export const EVENT_TABLE_SKIN_IDS: string[] = ['final_table'];

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
  'place_las_vegas',
  'place_paris',
  'place_london',
  'place_tokyo',
  'place_dubai',
  'place_sydney',
  'place_rio',
  'place_santorini',
  'place_new_york',
  'place_monaco',
  'skin_shadow_suits',
  'skin_gilded_fall',
  'skin_crimson_damask',
  'skin_graphite_embossed',
  'skin_obsidian_micro',
  'skin_emerald_argyle',
  'skin_ultraviolet_suits',
  'skin_black_gold_chips',
  'skin_golden_sparks',
  'skin_platinum_deco',
];

/** Lightweight derivatives used only by dense Studio grids. */
export const TABLE_SKIN_THUMBNAILS: Record<string, string> = Object.fromEntries(
  TABLE_SKIN_IDS.map((id) => [id, thumbnail(tableThumbnailModules, 'tables', `skin_${id}`)])
);

export const TABLE_BACKGROUND_THUMBNAILS: Record<string, string> = Object.fromEntries(
  TABLE_BACKGROUND_IDS.map((id) => [
    id,
    thumbnail(backgroundThumbnailModules, 'backgrounds', `bg_${id}`),
  ])
);
