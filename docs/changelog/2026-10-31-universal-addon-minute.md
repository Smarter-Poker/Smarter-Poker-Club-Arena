# All Add-On Tournaments Receive One Fully Parked Minute

Owner October 31, 2026 requires a 60-second add-on closing break for every tournament. The existing manager drains every dealer before committing that closing window; a legacy `addon_break_minutes` value must no longer change its length. The manager now owns a fixed 60-second duration, and scheduled creation stores one minute. Paid and Free Buy paths share it, including restart recovery and the existing synchronized-break overlap.

Real manager and dealer tests exercise last-hand completion, every-table parking, persisted deadlines, duplicate openings, restart/lost acknowledgement, freeze/thaw and regular-break overlap. The duration law tests older 1-, 5- and 10-minute settings; real dealer tests use a legacy seven-minute setting. No financial, admission or recovery mutation is part of this delivery.

This is engine runtime source. Protected merge and staging are distinct from daily-window activation and live proof. The separate client notice uses the existing engine contract and can publish independently.
