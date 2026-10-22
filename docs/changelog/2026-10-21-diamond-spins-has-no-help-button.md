# Diamond Spins Has No Help Button

Owner instruction, October 21, 2026: remove the question mark from Diamond Spins.

The round "?" in the Diamond Spins header was the `PageHelp` tour passed into
`WheelCabinet` through its optional `help` prop. `DiamondWheelPage` no longer
passes it, so the cabinet renders no help slot on that screen. The other Diamond
games keep their own help buttons; this change is scoped to Diamond Spins only.

Files: `src/pages/DiamondWheelPage.tsx`.
