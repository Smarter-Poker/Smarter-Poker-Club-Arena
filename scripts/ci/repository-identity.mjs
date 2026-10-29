// A repository transfer changes its full name, never its immutable GitHub ID.
// Keep both explicitly approved names so trusted main works before and after transfer.
export const CLUB_ARENA_REPOSITORY_ID = '1132369872';
export const CLUB_ARENA_REPOSITORIES = Object.freeze([
  'Smarter-Poker/Smarter-Poker-Club-Arena',
  'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
]);
export function isClubArenaRepository(repository, repositoryId) {
  return CLUB_ARENA_REPOSITORIES.includes(repository) &&
    String(repositoryId) === CLUB_ARENA_REPOSITORY_ID;
}
export function assertClubArenaRepository(repository, repositoryId) {
  if (!isClubArenaRepository(repository, repositoryId)) throw Error('Wrong Club Arena repository identity');
  return repository;
}
