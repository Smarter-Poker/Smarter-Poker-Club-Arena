import React from 'react';

// Preloads all 14 button assets so toggling themes is instant with no FOUC
export function ButtonImagePreloader() {
  const supabaseUrl =
    import.meta.env.VITE_SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
  const icons = [
    'icon-addscreen',
    'icon-chat',
    'icon-hamburger',
    'icon-prevhand',
    'icon-rabbit',
    'icon-stats',
    'icon-timebank',
  ];

  return (
    <div style={{ display: 'none' }} aria-hidden="true">
      {icons.map((icon) => (
        <React.Fragment key={icon}>
          <link
            rel="preload"
            as="image"
            href={`${supabaseUrl}/storage/v1/object/public/assets/buttons/black/${icon}.webp`}
          />
          <link
            rel="preload"
            as="image"
            href={`${supabaseUrl}/storage/v1/object/public/assets/buttons/blue/${icon}.webp`}
          />
        </React.Fragment>
      ))}
    </div>
  );
}
