/**
 * 🎯 GTO Query Service
 * Fast lookup of solved scenarios for training games and horse decisions
 */

import { supabase } from '../lib/supabase';
import md5 from 'md5';

export interface GTOSolution {
    gto_action: string;
    gto_frequencies: Record<string, number>;
    ev: number | null;
    ev_by_action: Record<string, number> | null;
    raise_sizes: Record<string, number> | null;
}

export interface PreflopRange {
    range_string: string;
    range_grid: Record<string, number> | null;
    open_frequency: number | null;
    call_frequency: number | null;
    raise_frequency: number | null;
}

class GTOQueryServiceClass {
    private cache: Map<string, GTOSolution> = new Map();

    /**
     * Compute scenario hash matching the DB function
     */
    computeHash(
        position: string,
        potType: string,
        street: string,
        board: string[] | null,
        actionFacing: string,
        stackDepth: number = 100
    ): string {
        const raw = `${position}|${potType}|${street}|${(board || []).join(',')}|${actionFacing}|${stackDepth}`;
        return md5(raw);
    }

    /**
     * Get the GTO solution for a scenario
     */
    async getGTOAction(
        position: string,
        potType: string,
        street: string,
        board: string[] | null = null,
        actionFacing: string = 'check',
        stackDepth: number = 100
    ): Promise<GTOSolution | null> {
        const scenarioHash = this.computeHash(position, potType, street, board, actionFacing, stackDepth);

        // Check cache first
        if (this.cache.has(scenarioHash)) {
            return this.cache.get(scenarioHash)!;
        }

        // Query database
        const { data, error } = await supabase
            .from('gto_solutions')
            .select('gto_action, gto_frequencies, ev, ev_by_action, raise_sizes')
            .eq('scenario_hash', scenarioHash)
            .single();

        if (error || !data) {
            return null;
        }

        const solution = data as GTOSolution;
        this.cache.set(scenarioHash, solution);
        return solution;
    }

    /**
     * Get preflop range for a position/action
     */
    async getPreflopRange(
        position: string,
        actionType: string,
        facingPosition: string | null = null,
        stackDepth: number = 100
    ): Promise<PreflopRange | null> {
        let query = supabase
            .from('preflop_ranges')
            .select('*')
            .eq('position', position)
            .eq('action_type', actionType)
            .eq('stack_depth_bb', stackDepth);

        if (facingPosition) {
            query = query.eq('facing_position', facingPosition);
        }

        const { data, error } = await query.single();
        return error ? null : data as PreflopRange;
    }

    /**
     * Add a scenario to the solve queue
     */
    async queueScenario(
        position: string,
        potType: string,
        street: string,
        board: string[] | null = null,
        actionFacing: string = 'check',
        stackDepth: number = 100,
        priority: number = 5
    ): Promise<string> {
        const scenarioHash = this.computeHash(position, potType, street, board, actionFacing, stackDepth);

        // Check if already exists
        const { data: existing } = await supabase
            .from('gto_solutions')
            .select('id')
            .eq('scenario_hash', scenarioHash);

        if (existing?.length) {
            return scenarioHash;
        }

        // Add to queue
        await supabase.from('gto_solve_queue').insert({
            scenario_hash: scenarioHash,
            position,
            pot_type: potType,
            street,
            board,
            action_facing: actionFacing,
            stack_depth_bb: stackDepth,
            priority
        });

        return scenarioHash;
    }

    /**
     * Check if a scenario has been solved
     */
    async isSolved(scenarioHash: string): Promise<boolean> {
        if (this.cache.has(scenarioHash)) {
            return true;
        }

        const { data } = await supabase
            .from('gto_solutions')
            .select('id')
            .eq('scenario_hash', scenarioHash);

        return !!data?.length;
    }

    /**
     * Clear the in-memory cache
     */
    clearCache(): void {
        this.cache.clear();
    }
}

export const GTOQueryService = new GTOQueryServiceClass();
export default GTOQueryService;
