# Measure the responsive footer artwork wrapper

The hosted lobby footer check still selected the base image parent after the responsive footer added a picture element. The absolutely positioned image leaves that inline picture with zero height. The retained Chromium and WebKit traces measured a 59.3125 pixel gap, exactly the phone footer height, while the painted frame remained at the bottom edge.

Measure the artwork wrapper that owns the single role-qualified doors list. Independently require its picture to contain the correct member or operator base frame. This also avoids matching the separate member artwork slices. Keep the fixed positioning, role qualification, frame existence and less-than-one-pixel painted-edge requirement unchanged. The separate footer-route check already received the corresponding responsive-wrapper update in PR #7390.

Validation: retained failing hosted trace and screenshot, current production component source, focused maintained production lobby acceptance, app TypeScript compilation and ordinary pre-push checks. Protected checks and unchanged exact-release hosted closing proof remain required.
