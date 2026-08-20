/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VIP AVATAR LIBRARY — mirror of the Hub's AVATAR_LIBRARY VIP tier
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: 26 new transparent VIP avatars (Bounty Hunter, Cyber
 * Assassin, Yakuza, Neon Ninja, ...) were added to the Hub's
 * src/data/AVATAR_LIBRARY.js and shipped as files under its public/avatars/vip/.
 * Club Arena could not see a single one of them, because AvatarService builds
 * its gallery by listing the Supabase 'social-media/avatars' storage bucket -
 * 436 objects, not one of which is any of these. The new artwork existed on
 * disk and was unreachable from the table.
 *
 * Club Arena is served from smarter.poker/hub/club-arena/, the same origin as
 * the Hub, so /avatars/vip/<file>.png resolves straight to the Hub's public/
 * directory. No upload, no bucket sync, no second copy of the artwork: both
 * apps read the one set of files.
 *
 * GENERATED from the Hub library - regenerate rather than hand-editing when
 * avatars are added there, so the two lists cannot drift.
 */

export interface VipAvatarEntry {
  id: string;
  name: string;
  category: string;
  /** Absolute, same-origin path into the Hub's public/avatars/vip/ */
  image: string;
}

export const VIP_AVATAR_LIBRARY: VipAvatarEntry[] = [
  { id: 'vip-people-001', name: 'Political Leader', category: 'people', image: '/avatars/vip/politician.png' },
  { id: 'vip-people-002', name: 'Rock Legend', category: 'people', image: '/avatars/vip/rock_legend.png' },
  { id: 'vip-people-003', name: 'Tech Mogul', category: 'people', image: '/avatars/vip/tech_mogul.png' },
  { id: 'vip-people-004', name: 'Aerospace Pioneer', category: 'people', image: '/avatars/vip/space_pioneer.png' },
  { id: 'vip-people-005', name: 'Silent Film Actor', category: 'people', image: '/avatars/vip/silent_actor.png' },
  { id: 'vip-people-006', name: 'Liberty Statue', category: 'culture', image: '/avatars/vip/liberty.png' },
  { id: 'vip-people-007', name: 'Royal Monarch', category: 'culture', image: '/avatars/vip/monarch.png' },
  { id: 'vip-people-008', name: 'Hollywood Star', category: 'people', image: '/avatars/vip/hollywood.png' },
  { id: 'vip-people-009', name: 'Pro Wrestler', category: 'sports', image: '/avatars/vip/wrestler.png' },
  { id: 'vip-people-010', name: 'Football Pro', category: 'sports', image: '/avatars/vip/football.png' },
  { id: 'vip-people-011', name: 'Basketball Star', category: 'sports', image: '/avatars/vip/basketball.png' },
  { id: 'vip-people-012', name: 'Soccer Champion', category: 'sports', image: '/avatars/vip/soccer.png' },
  { id: 'vip-people-013', name: 'Boxing Champion', category: 'sports', image: '/avatars/vip/boxer.png' },
  { id: 'vip-people-014', name: 'Physics Professor', category: 'people', image: '/avatars/vip/physicist.png' },
  { id: 'vip-people-015', name: 'Renaissance Artist', category: 'culture', image: '/avatars/vip/artist.png' },
  { id: 'vip-people-016', name: 'Hip-Hop Artist', category: 'people', image: '/avatars/vip/rapper.png' },
  { id: 'vip-people-017', name: 'Dance Icon', category: 'people', image: '/avatars/vip/dancer.png' },
  { id: 'vip-people-018', name: 'Country Singer', category: 'people', image: '/avatars/vip/country.png' },
  { id: 'vip-people-019', name: 'Jazz Musician', category: 'people', image: '/avatars/vip/jazz.png' },
  { id: 'vip-people-020', name: 'Horror Director', category: 'people', image: '/avatars/vip/director.png' },
  { id: 'vip-fantasy-001', name: 'Secret Agent', category: 'fantasy', image: '/avatars/vip/secret_agent.png' },
  { id: 'vip-fantasy-004', name: 'Dragon Emperor', category: 'fantasy', image: '/avatars/vip/dragon.png' },
  { id: 'vip-fantasy-005', name: 'Phoenix Rising', category: 'fantasy', image: '/avatars/vip/phoenix.png' },
  { id: 'vip-fantasy-006', name: 'Unicorn Magic', category: 'fantasy', image: '/avatars/vip/unicorn.png' },
  { id: 'vip-fantasy-007', name: 'Vampire Count', category: 'fantasy', image: '/avatars/vip/vampire.png' },
  { id: 'vip-fantasy-008', name: 'Elite Cyborg', category: 'fantasy', image: '/avatars/vip/elite_cyborg.png' },
  { id: 'vip-fantasy-009', name: 'Plague Doctor', category: 'fantasy', image: '/avatars/vip/plague_doctor.png' },
  { id: 'vip-fantasy-010', name: 'Space Ranger', category: 'fantasy', image: '/avatars/vip/space_ranger.png' },
  { id: 'vip-fantasy-011', name: 'Ancient Mummy', category: 'fantasy', image: '/avatars/vip/mummy.png' },
  { id: 'vip-fantasy-012', name: 'Galactic Alien', category: 'fantasy', image: '/avatars/vip/alien.png' },
  { id: 'vip-fantasy-013', name: 'Ice Queen', category: 'fantasy', image: '/avatars/vip/ice_queen.png' },
  { id: 'vip-fantasy-014', name: 'Fire Demon', category: 'fantasy', image: '/avatars/vip/fire_demon.png' },
  { id: 'vip-fantasy-015', name: 'Guardian Angel', category: 'fantasy', image: '/avatars/vip/angel.png' },
  { id: 'vip-animal-001', name: 'Grumpy Cat', category: 'animals', image: '/avatars/vip/grumpy_cat.png' },
  { id: 'vip-animal-002', name: 'Business Cat', category: 'animals', image: '/avatars/vip/business_cat.png' },
  { id: 'vip-animal-003', name: 'Pug Life', category: 'animals', image: '/avatars/vip/pug.png' },
  { id: 'vip-animal-004', name: 'Majestic Eagle', category: 'animals', image: '/avatars/vip/eagle.png' },
  { id: 'vip-animal-005', name: 'Honey Badger', category: 'animals', image: '/avatars/vip/badger.png' },
  { id: 'vip-animal-006', name: 'Charging Bull', category: 'animals', image: '/avatars/vip/bull.png' },
  { id: 'vip-animal-007', name: 'Alpha Wolf', category: 'animals', image: '/avatars/vip/wolf.png' },
  { id: 'vip-animal-008', name: 'Wise Gorilla', category: 'animals', image: '/avatars/vip/gorilla.png' },
  { id: 'vip-animal-009', name: 'Sneaky Panther', category: 'animals', image: '/avatars/vip/panther.png' },
  { id: 'vip-animal-010', name: 'Grizzly Bear', category: 'animals', image: '/avatars/vip/bear.png' },
  { id: 'vip-culture-001', name: 'Egyptian Pharaoh', category: 'culture', image: '/avatars/vip/pharaoh.png' },
  { id: 'vip-culture-002', name: 'Viking Warrior', category: 'culture', image: '/avatars/vip/viking_warrior.png' },
  { id: 'vip-culture-003', name: 'Geisha Master', category: 'culture', image: '/avatars/vip/geisha_master.png' },
  { id: 'vip-culture-004', name: 'Aztec Warrior', category: 'culture', image: '/avatars/vip/aztec_warrior.png' },
  { id: 'vip-culture-005', name: 'Spartan Hero', category: 'culture', image: '/avatars/vip/spartan.png' },
  { id: 'vip-new-001', name: 'Arctic Explorer', category: 'archetypes', image: '/avatars/vip/arctic_explorer.png' },
  { id: 'vip-new-002', name: 'Astronaut', category: 'archetypes', image: '/avatars/vip/astronaut.png' },
  { id: 'vip-new-003', name: 'Bounty Hunter', category: 'archetypes', image: '/avatars/vip/bounty_hunter.png' },
  { id: 'vip-new-004', name: 'Casino Dealer', category: 'archetypes', image: '/avatars/vip/casino_dealer.png' },
  { id: 'vip-new-005', name: 'Cyber Assassin', category: 'archetypes', image: '/avatars/vip/cyber_assassin.png' },
  { id: 'vip-new-006', name: 'Cyber Punk', category: 'archetypes', image: '/avatars/vip/cyber_punk.png' },
  { id: 'vip-new-007', name: 'Dj', category: 'archetypes', image: '/avatars/vip/dj.png' },
  { id: 'vip-new-008', name: 'Galactic Emperor', category: 'archetypes', image: '/avatars/vip/galactic_emperor.png' },
  { id: 'vip-new-009', name: 'Gladiator', category: 'archetypes', image: '/avatars/vip/gladiator.png' },
  { id: 'vip-new-010', name: 'Hacker', category: 'archetypes', image: '/avatars/vip/hacker.png' },
  { id: 'vip-new-011', name: 'Luchador', category: 'archetypes', image: '/avatars/vip/luchador.png' },
  { id: 'vip-new-012', name: 'Mad Scientist', category: 'archetypes', image: '/avatars/vip/mad_scientist.png' },
  { id: 'vip-new-013', name: 'Mecha Pilot', category: 'archetypes', image: '/avatars/vip/mecha_pilot.png' },
  { id: 'vip-new-014', name: 'Mobster', category: 'archetypes', image: '/avatars/vip/mobster.png' },
  { id: 'vip-new-015', name: 'Neon Ninja', category: 'archetypes', image: '/avatars/vip/neon_ninja.png' },
  { id: 'vip-new-016', name: 'Phantom', category: 'archetypes', image: '/avatars/vip/phantom.png' },
  { id: 'vip-new-017', name: 'Royal Guard', category: 'archetypes', image: '/avatars/vip/royal_guard.png' },
  { id: 'vip-new-018', name: 'Samurai Cyborg', category: 'archetypes', image: '/avatars/vip/samurai_cyborg.png' },
  { id: 'vip-new-019', name: 'Sorceress', category: 'archetypes', image: '/avatars/vip/sorceress.png' },
  { id: 'vip-new-020', name: 'Space Pirate', category: 'archetypes', image: '/avatars/vip/space_pirate.png' },
  { id: 'vip-new-021', name: 'Steampunk Inventor', category: 'archetypes', image: '/avatars/vip/steampunk_inventor.png' },
  { id: 'vip-new-022', name: 'Street Racer', category: 'archetypes', image: '/avatars/vip/street_racer.png' },
  { id: 'vip-new-023', name: 'Tiger Boss', category: 'archetypes', image: '/avatars/vip/tiger_boss.png' },
  { id: 'vip-new-024', name: 'Vampire Hunter', category: 'archetypes', image: '/avatars/vip/vampire_hunter.png' },
  { id: 'vip-new-025', name: 'Voodoo Priest', category: 'archetypes', image: '/avatars/vip/voodoo_priest.png' },
  { id: 'vip-new-026', name: 'Yakuza', category: 'archetypes', image: '/avatars/vip/yakuza.png' },
];

export default VIP_AVATAR_LIBRARY;
