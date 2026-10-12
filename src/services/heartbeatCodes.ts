/**
 * Why a heartbeat did not succeed, as a code the table page can branch on.
 *
 * In a module of their own so the table page can read them without importing
 * a second name from GameServerAPI: that module is replaced wholesale by
 * several mounted-page tests, and a constant missing from a replacement is an
 * error at the moment it is read.
 */

/** The engine answered "no game for this table" (HTTP 404). */
export const HEARTBEAT_TABLE_NOT_RUNNING = 'TABLE_ENGINE_NOT_FOUND';

/** No answer at all: the request failed or outlived its deadline. */
export const HEARTBEAT_NOT_DELIVERED = 'HEARTBEAT_NOT_DELIVERED';
