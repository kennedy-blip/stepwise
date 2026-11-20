import { describe, expect, it } from 'vitest';
import {
  addFlow,
  consumeFlowSave,
  createFlowState,
  decayFlow,
  flowTierSpeedMultiplier,
  registerCleanMove,
  tierForValue,
} from '../src/game/flow';
import { PHYSICS } from '../src/game/config';

describe('Flow Meter', () => {
  it('starts at zero in tier 1', () => {
    const flow = createFlowState();
    expect(flow.value).toBe(0);
    expect(flow.tier).toBe(1);
    expect(flow.armed).toBe(false);
    expect(flow.cleanMoves).toBe(0);
  });

  it('maps values to the correct tier', () => {
    expect(tierForValue(0)).toBe(1);
    expect(tierForValue(33)).toBe(1);
    expect(tierForValue(34)).toBe(2);
    expect(tierForValue(79)).toBe(2);
    expect(tierForValue(80)).toBe(3);
    expect(tierForValue(100)).toBe(3);
  });

  it('awards the specified flow for a vault', () => {
    const flow = createFlowState();
    addFlow(flow, PHYSICS.flowRewardVault);
    expect(flow.value).toBe(20);
    expect(flow.tier).toBe(1);
  });

  it('promotes to tier 2 when passing the 34% threshold', () => {
    const flow = createFlowState();
    addFlow(flow, 20);
    addFlow(flow, 20);
    expect(flow.value).toBe(40);
    expect(flow.tier).toBe(2);
  });

  it('promotes to tier 3 and arms the Flow Save at 80%', () => {
    const flow = createFlowState();
    addFlow(flow, 80);
    expect(flow.value).toBe(80);
    expect(flow.tier).toBe(3);
    expect(flow.armed).toBe(true);
  });

  it('clamps flow to the 0..100 range', () => {
    const flow = createFlowState();
    addFlow(flow, 500);
    expect(flow.value).toBe(100);
    addFlow(flow, -500);
    expect(flow.value).toBe(0);
  });

  it('tracks the peak flow value', () => {
    const flow = createFlowState();
    addFlow(flow, 60);
    addFlow(flow, -40);
    expect(flow.value).toBe(20);
    expect(flow.peak).toBe(60);
  });

  it('decays flow at the configured rate while hesitating', () => {
    const flow = createFlowState();
    addFlow(flow, 50);
    decayFlow(flow, 1, true, 5);
    expect(flow.value).toBeCloseTo(45, 6);
  });

  it('does not decay flow while the runner is moving', () => {
    const flow = createFlowState();
    addFlow(flow, 50);
    decayFlow(flow, 1, false, 5);
    expect(flow.value).toBe(50);
  });

  it('consumes 50% of flow and disarms on a Flow Save', () => {
    const flow = createFlowState();
    addFlow(flow, 90);
    expect(flow.armed).toBe(true);

    const used = consumeFlowSave(flow);
    expect(used).toBe(true);
    expect(flow.value).toBeCloseTo(40, 6);
    expect(flow.tier).toBe(2);
    expect(flow.armed).toBe(false);
    expect(flow.savesUsed).toBe(1);
  });

  it('refuses a Flow Save when not in Pure Flow', () => {
    const flow = createFlowState();
    addFlow(flow, 50);
    expect(consumeFlowSave(flow)).toBe(false);
    expect(flow.value).toBe(50);
    expect(flow.savesUsed).toBe(0);
  });

  it('grants the documented tier speed multipliers', () => {
    expect(flowTierSpeedMultiplier(1)).toBe(1);
    expect(flowTierSpeedMultiplier(2)).toBe(1.15);
    expect(flowTierSpeedMultiplier(3)).toBe(1.25);
  });

  it('counts clean moves', () => {
    const flow = createFlowState();
    registerCleanMove(flow);
    registerCleanMove(flow);
    expect(flow.cleanMoves).toBe(2);
  });

  it('drops the tier when flow falls after a stumble', () => {
    const flow = createFlowState();
    addFlow(flow, 85);
    expect(flow.tier).toBe(3);
    addFlow(flow, -PHYSICS.stumbleFlowLoss);
    expect(flow.value).toBe(45);
    expect(flow.tier).toBe(2);
    expect(flow.armed).toBe(false);
  });
});
