import { useAuthUser } from './useAuthUser';
import { useUserTableSettings } from './useUserTableSettings';

export function useButtonImage(iconName: string) {
  const { user } = useAuthUser();
  const { settings } = useUserTableSettings(user?.id);
  const color = settings.blue_buttons_enabled ? 'blue' : 'black';
  const supabaseUrl =
    import.meta.env.VITE_SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
  return `${supabaseUrl}/storage/v1/object/public/assets/buttons/${color}/${iconName}.webp`;
}
