/**
 * The Flow Meter.
 *
 * Flow is the game's only "health" resource and doubles as a momentum
 * multiplier. It has three tiers, each granting a speed bonus, and Tier 3
 * ("Pure Flow") arms the Flow Save recovery mechanic.
 */

import { clamp } from '../core/math';
import { FLOW_TIER_SPEEDS, PHYSICS } from './config';
import type { FlowTier } from '../core/types';

export interface FlowState {
  /** Current flow, 0..100. */
  value: number;
  /** Highest flow reached this run. */
  peak: number;
  /** Tier derived from the current value. */
  tier: FlowTier;
  /** Number of Flow Saves consumed this run. */
  savesUsed: number;
  /** Whether Flow Save is currently armed (Tier 3 and above). */
  armed: boolean;
  /** Count of clean parkour moves (vaults, rolls, slide-unders, edge leaps). */
  cleanMoves: number;
  /** Length of the current run of consecutive clean moves. */
  streak: number;
  /** True once the runner has entered Pure Flow (Tier 3). */
  pureFlow: boolean;
}

export function createFlowState(): FlowState {
  return {
    value: 0,
    peak: 0,
    tier: 1,
    savesUsed: 0,
    armed: false,
    cleanMoves: 0,
    streak: 0,
    pureFlow: false,
  };
}

export function tierForValue(value: number): FlowTier {
  if (value >= PHYSICS.flowTier3) return 3;
  if (value >= PHYSICS.flowTier2) return 2;
  return 1;
}

export function flowTierSpeedMultiplier(tier: FlowTier): number {
  return FLOW_TIER_SPEEDS[tier];
}

/**
 * Adds flow and updates the tier. Negative amounts are clamped to zero and
 * never push the tier below 1.
 */
export function addFlow(state: FlowState, amount: number): FlowState {
  state.value = clamp(state.value + amount, 0, 100);
  if (state.value > state.peak) state.peak = state.value;
  state.tier = tierForValue(state.value);
  state.armed = state.tier === 3;
  state.pureFlow = state.tier === 3;
  return state;
}

/**
 * Applies the passive decay that happens when the runner hesitates.
 * `hesitating` is true when the player is moving slowly or standing still.
 */
export function decayFlow(
  state: FlowState,
  dt: number,
  hesitating: boolean,
  rate: number,
): FlowState {
  if (!hesitating || rate <= 0) return state;
  state.value = clamp(state.value - rate * dt, 0, 100);
  state.tier = tierForValue(state.value);
  state.armed = state.tier === 3;
  return state;
}

/**
 * Consumes a Flow Save. Returns true when the save was actually available.
 */
export function consumeFlowSave(state: FlowState): boolean {
  if (!state.armed) return false;
  state.value = clamp(state.value - PHYSICS.flowSaveCost, 0, 100);
  state.tier = tierForValue(state.value);
  state.armed = state.tier === 3;
  state.savesUsed += 1;
  return true;
}

/**
 * Records a clean parkour move for the end-of-run summary.
 *
 * A run of consecutive clean moves builds momentum: every `streakStep` clean
 * moves in a row grants a bonus and pushes the meter toward Pure Flow. A
 * stumble or a broken move resets the streak.
 */
export function registerCleanMove(state: FlowState): number {
  state.cleanMoves += 1;
  state.streak += 1;

  const bonus = PHYSICS.flowStreakBonus;
  const step = PHYSICS.flowStreakStep;
  if (bonus > 0 && step > 0 && state.streak > 0 && state.streak % step === 0) {
    addFlow(state, bonus);
    return bonus;
  }
  return 0;
}

/** Breaks the clean-move streak (a stumble, a broken plank, a hit). */
export function breakCleanStreak(state: FlowState): void {
  state.streak = 0;
}
