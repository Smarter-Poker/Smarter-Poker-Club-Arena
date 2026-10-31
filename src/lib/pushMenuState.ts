/**
 * What the hamburger's "Turn On Notifications" row should offer on this device
 * (Dan, 2026-10-31: "THE TURN ON NOTIFICATIONS IS GONE FROM THE HAMBURGER
 * MENU... THAT PROBABLY NEEDS TO BE ADDED BACK IN GLOBALLY").
 *
 *   'ask'     - push works here and this device holds no subscription: the
 *               tap enrols it (enablePush, inside the tap gesture).
 *   'install' - an iPhone or iPad in a plain Safari tab. Apple only allows
 *               push from an installed Home Screen app, so the row opens the
 *               Notifications page, whose banner says how.
 *   'blocked' - the browser denied permission. The row opens the
 *               Notifications page, whose banner explains how to allow it.
 *   null      - nothing to offer: this device already receives push, or the
 *               browser cannot receive it at all.
 *
 * Unlike PushEnableBanner, an explicit opt-out still gets 'ask': the banner is
 * a prompt and must not nag past a decision, but a menu row is the place a
 * player goes to change their mind.
 */
import {
  hasLocalSubscription,
  isIos,
  isIosStandalonePwa,
  isWebPushSupported,
  notificationPermission,
} from './pushClient';

export type PushMenuState = null | 'ask' | 'install' | 'blocked';

export async function pushMenuState(): Promise<PushMenuState> {
  if (!isWebPushSupported()) return isIos() && !isIosStandalonePwa() ? 'install' : null;
  if (notificationPermission() === 'denied') return 'blocked';
  try {
    const subscribed = await hasLocalSubscription();
    if (subscribed && notificationPermission() === 'granted') return null;
  } catch {
    /* could not tell: offering the row is the safe answer */
  }
  return 'ask';
}
