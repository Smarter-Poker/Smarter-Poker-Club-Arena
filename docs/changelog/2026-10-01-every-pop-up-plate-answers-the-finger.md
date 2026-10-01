# Every pop-up plate answers the finger on an iPhone (2026-10-01)

Phase 5 of the mobile graphics programme.

On an iPhone browser the only buzz a web page can still get is the tick iOS plays when a finger lands on a real switch, which is what `TapHaptic` draws invisibly inside a tap target. The game plates carried it; the pop-ups did not, so the cashier, deposit and withdraw, cash out request, buy-in, insurance, confirmations and the game receipts were silent under the finger.

A SpadeConsole plate now carries `TapHaptic` by itself when it sits inside any pop-up (`role="dialog"`, `role="alertdialog"`, `aria-modal="true"` or a `<dialog>`), looked up once when the plate mounts. `haptic={false}` turns it off for one plate and `haptic` turns it on outside a pop-up, as before. Nothing changes off an iPhone browser, on a disabled plate, or with the Vibrations switch off: `TapHaptic` itself decides all three.

The invisible switch is an input with `tabIndex -1`. Twenty-two pop-up focus traps listed every enabled input as a Tab stop, so with a switch inside their last plate, Tab would have walked out of the pop-up, and two opened their focus on the first input in the pop-up. Every one now leaves `tabindex -1` inputs out, the way `Modal.tsx` always has, and a test keeps any new trap from forgetting it. Four test files that stubbed the whole vibration gate now stub only the buzz.

Tests: `tests/components/PopupPlateHaptic.test.tsx` (a plate in a pop-up carries the switch and one on the page does not, a whole console in a pop-up, a disabled plate never ticks, an explicit choice either way, nothing off an iPhone, and no focus trap in `src` can land on the switch).
