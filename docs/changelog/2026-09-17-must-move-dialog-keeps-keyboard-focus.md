# Must Move lobby keeps keyboard focus

The live lobby left focus on the table's opening button and returned it to the
document body after clicking Close. `aria-modal` did not contain keyboard focus.

The lobby now uses the existing `useFocusTrap` hook, initially focusing Close.
Tab and Shift+Tab remain inside the dialog, and dismissal restores the opening
control. No gameplay action or shared keyboard behavior changes.

Three directly rendered regressions failed before the hook was connected and
passed afterward; the existing lobby audit suite passed all 41 cases. Protected
checks and published keyboard acceptance are separate delivery steps.
