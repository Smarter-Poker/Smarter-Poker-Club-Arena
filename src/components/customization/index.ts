/**
 * The customization barrel.
 *
 * 2026-08-26 sweep: `ThemeSelector` and `TableFeltSelector` were removed from
 * this file and from the repo. Both were correct, complete components with NO
 * CALL SITE — this barrel was their only referent, and nothing imports the
 * barrel either, so they were a closed loop. `TableFeltSelector` in particular
 * was a working felt picker that no route could reach, which is worse than a
 * missing feature: it reads as shipped.
 *
 * The felt/theme pickers players actually use are the tabs in
 * `components/table/ThemeSettingsModal.tsx`.
 */
export { AvatarCustomizer } from './AvatarCustomizer';
