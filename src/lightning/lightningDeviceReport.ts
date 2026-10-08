/**
 * LIGHTNING PHASE 8: WHICH ROOMS TELL THE ENGINE WHAT DEVICE THIS IS.
 *
 * The matcher holds each player to their device's Cluster limit
 * (desktop 4, tablet 3, phone 2 by default), and only the client knows the
 * device. It says so when it connects to a LIGHTNING room, and only there:
 * `?p=` on a per-room socket URL, `platform` on a multiplexed SUBSCRIBE.
 * Every other table's socket is byte-for-byte what it was.
 *
 * Kept free of imports beyond the pure capability rules, because the socket
 * clients import it and must stay light.
 */
import {
  lightningDeviceClass,
  readLightningPlatformSignals,
  type LightningDeviceClass,
} from './lightningCapabilities';

const lightningRooms = new Set<string>();
let device: LightningDeviceClass | null = null;

/** The pool-session registry calls this for every room it learns. */
export function markLightningRoom(roomId: string): void {
  if (roomId) lightningRooms.add(roomId);
}

/** This device's class, read once per page load. */
export function lightningDeviceNow(): LightningDeviceClass {
  if (!device) {
    try {
      device = lightningDeviceClass(readLightningPlatformSignals());
    } catch {
      device = 'desktop';
    }
  }
  return device;
}

/** The device class to report for a room: only a Lightning room reports one. */
export function lightningDeviceFor(roomId: string | null | undefined): LightningDeviceClass | null {
  return roomId && lightningRooms.has(roomId) ? lightningDeviceNow() : null;
}

/** A per-room socket URL with the device class added, for a Lightning room only. */
export function withLightningDevice(url: string, roomId: string | null | undefined): string {
  const p = lightningDeviceFor(roomId);
  if (!p) return url;
  return `${url}${url.includes('?') ? '&' : '?'}p=${p}`;
}

/** Tests only. */
export function resetLightningDeviceReportForTests(next: LightningDeviceClass | null = null): void {
  lightningRooms.clear();
  device = next;
}
