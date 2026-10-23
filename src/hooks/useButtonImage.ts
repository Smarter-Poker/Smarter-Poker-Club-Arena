import { useAuthUser } from './useAuthUser';
import { useBlueButtonsEnabled } from './useTableButtonStyle';

/**
 * The URL of a table button icon in the player's chosen skin.
 *
 * 2026-08-28: this used to call `useUserTableSettings(user?.id)` — a settings
 * ENGINE with a full row of state, five mutation refs and two MasterBus
 * subscriptions — to read ONE boolean. Six components call this hook, plus two
 * more calls inside TablePage, and MultiTablePage keeps four tables mounted: 32
 * engines and 64 subscriptions, all to choose between two words in a URL, and
 * every one of them re-rendering whenever any unrelated setting changed.
 *
 * `useBlueButtonsEnabled` is a read-only shared selector over that one flag.
 * See the note at the top of useTableButtonStyle.ts for why it is a separate
 * store rather than a refactor of the settings hook.
 */
export function useButtonImage(iconName: string) {
  const { user } = useAuthUser();
  const blueButtons = useBlueButtonsEnabled(user?.id);
  const color = blueButtons ? 'blue' : 'black';
  const supabaseUrl =
    import.meta.env.VITE_SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
  return `${supabaseUrl}/storage/v1/object/public/assets/buttons/${color}/${iconName}.webp`;
}

/**
 * The time-bank stopwatch, centred in its frame (Dan 2026-10-22: "the stop
 * watch icon should be centered to its frame"). The approved storage art draws
 * the glyph 28px (of 256) above the frame's centre; these bundled copies are
 * the same black and blue masters with only the glyph re-seated, so the frame,
 * its gutters and TableToolIconSizing.css's normalisation are unchanged.
 */
export function useTimebankIcon(): string {
  const { user } = useAuthUser();
  const color = useBlueButtonsEnabled(user?.id) ? 'blue' : 'black';
  return `${import.meta.env.BASE_URL}assets/club-buttons/timebank-centered-${color}-v1.webp`;
}
