# Certify the approved footer for the current account role

The direct live verification on release `6afa6822` used a new member account.
Its footer correctly loaded the approved player frame, but the final geometry
check required the operator frame. The retained browser trace proves the player
image loaded successfully and the unique fixed footer was visible.

The certificate now requires the explicit member/operator door kind and selects
that role's exact approved base image. It retains the unique frame, fixed footer
and strict one-pixel bottom-edge geometry assertions. Unknown roles still fail.
There is no product, artwork, role, financial or timeout change.
