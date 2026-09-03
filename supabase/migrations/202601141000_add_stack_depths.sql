-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎯 ADD MISSING STACK DEPTHS (40bb, 60bb, 80bb)
-- For Cash Games and Tournaments
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add missing stack depths for Cash Games
DO $$
DECLARE
    format_rec RECORD;
BEGIN
    FOR format_rec IN SELECT id FROM game_formats WHERE category = 'cash' LOOP
        INSERT INTO stack_depth_configs (game_format_id, stack_depth_bb, solve_priority) VALUES
        (format_rec.id, 40, 8),
        (format_rec.id, 60, 7),
        (format_rec.id, 80, 7)
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

-- Add missing stack depths for MTT
DO $$
DECLARE
    format_rec RECORD;
BEGIN
    FOR format_rec IN SELECT id FROM game_formats WHERE category = 'mtt' LOOP
        INSERT INTO stack_depth_configs (game_format_id, stack_depth_bb, solve_priority) VALUES
        (format_rec.id, 60, 6),
        (format_rec.id, 80, 5),
        (format_rec.id, 200, 4)
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

-- Add missing stack depths for SNG
DO $$
DECLARE
    format_rec RECORD;
BEGIN
    FOR format_rec IN SELECT id FROM game_formats WHERE category = 'sng' LOOP
        INSERT INTO stack_depth_configs (game_format_id, stack_depth_bb, solve_priority) VALUES
        (format_rec.id, 40, 6),
        (format_rec.id, 60, 5),
        (format_rec.id, 80, 5),
        (format_rec.id, 100, 4)
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

-- Verify the stack depths
SELECT 
    gf.code as format,
    gf.category,
    array_agg(sdc.stack_depth_bb ORDER BY sdc.stack_depth_bb) as stacks
FROM game_formats gf
LEFT JOIN stack_depth_configs sdc ON sdc.game_format_id = gf.id
GROUP BY gf.code, gf.category
ORDER BY gf.category, gf.code;
