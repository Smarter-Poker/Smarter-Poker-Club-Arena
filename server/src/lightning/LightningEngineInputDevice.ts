/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ENGINE IS A HORSE'S INPUT DEVICE, AND IT CAN SAY SO (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The presence door (`fn_lightning_presence_report`) is told two things: a
 * player's last input device went away (disconnected) and a player's input
 * device came back (reconnected). A person's input device is their browser,
 * so their room socket says both (LightningRegistry.connect / disconnect).
 * A horse's input device is its anchor engine (CLAUDE.md 10.5 item 2): the
 * engine heartbeats the seat and HorseLogic chooses its actions. Until this
 * file the engine had no way to say "it is here", so a horse stamped
 * disconnected (a batch at an engine restart, 2026-10-24 15:49:46 UTC) could
 * never be un-stamped and the reaper exited four heartbeating horses
 * 'disconnect_expired' at 15:52:50.
 *
 * This is the one narrow port the anchor engine reports through. GameServer
 * wires it to LightningRegistry.engineInputDeviceLive, which refuses a seat
 * the horse account's own client controls and otherwise reports
 * `reconnected` through the SAME reporter a returning room socket uses: the
 * same batching, the same bounded retry, the same SQL door. Nothing here
 * reads or writes a seat (src/lightning never touches one).
 */
import { isUuid } from './LightningRpc.js';

/**
 * The anchor engine's live heartbeat for a horse it drives, whose open pool
 * session (`poolSessionId`, the player's room) carries a disconnect stamp.
 * Answers whether a reconnect was reported.
 */
export type LightningEngineInputDeviceSink = (
  clusterId: string,
  playerId: string,
  poolSessionId: string
) => boolean;

let sink: LightningEngineInputDeviceSink | null = null;

/** Boot wiring (GameServer); null unwires (shutdown, tests). */
export function setLightningEngineInputDeviceSink(
  next: LightningEngineInputDeviceSink | null
): void {
  sink = next;
}

/** The anchor engine's report. Never throws; unwired or refused answers false. */
export function reportLightningEngineInputDeviceLive(
  clusterId: string,
  playerId: string,
  poolSessionId: string
): boolean {
  if (!sink || !isUuid(clusterId) || !isUuid(playerId) || !isUuid(poolSessionId)) return false;
  try {
    return sink(clusterId, playerId, poolSessionId) === true;
  } catch {
    return false;
  }
}
