import { describe, expect, test } from 'bun:test';
import type { Storyboard } from '@coji/shared/storyboard';
import { type ShotActionPlanner, planShots } from './shot-planner.ts';

const SB: Storyboard = {
  assistant: false,
  frames: [
    { preset: 'wide' },
    { preset: 'close-up' },
    { preset: 'over-shoulder' },
    { preset: 'low-angle' },
  ],
};

describe('shot-planner', () => {
  test('uses the storyboard presets — distinct framings, short labels', async () => {
    const shots = await planShots('a woman at a kitchen table', { storyboard: SB });
    expect(shots).toHaveLength(4);
    expect(new Set(shots.map((s) => s.prompt)).size).toBe(4); // all distinct
    expect(shots.map((s) => s.label)).toEqual([
      'Wide',
      'Close-up',
      'Over the shoulder',
      'Low angle',
    ]);
    for (const s of shots) {
      expect(s.prompt).toContain('a woman at a kitchen table');
      expect(s.prompt.toLowerCase()).toContain('shot:');
    }
  });

  test('assistant OFF ignores the planner (manual actions, no LLM)', async () => {
    let called = false;
    const planner: ShotActionPlanner = async ({ framings }) => {
      called = true;
      return framings.map((_, i) => `llm action ${i}`);
    };
    const shots = await planShots('concept', { storyboard: SB, planner });
    expect(called).toBe(false);
    expect(shots.every((s) => !s.prompt.includes('llm action'))).toBe(true);
  });

  test('assistant ON applies the planner actions', async () => {
    const on: Storyboard = { ...SB, assistant: true };
    const planner: ShotActionPlanner = async ({ framings }) =>
      framings.map((_, i) => `llm action ${i}`);
    const shots = await planShots('concept', { storyboard: on, planner });
    shots.forEach((s, i) => expect(s.prompt).toContain(`llm action ${i}`));
  });

  test('assistant ON tolerates a planner returning null (preset defaults)', async () => {
    const on: Storyboard = { ...SB, assistant: true };
    const nullish: ShotActionPlanner = async () => null;
    const shots = await planShots('concept', { storyboard: on, planner: nullish });
    expect(shots).toHaveLength(4);
    expect(shots.every((s) => s.prompt.length > 0)).toBe(true);
  });

  test('defaults to a varied 4-shot storyboard when none provided', async () => {
    const shots = await planShots('concept', {});
    expect(shots).toHaveLength(4);
    expect(new Set(shots.map((s) => s.label)).size).toBeGreaterThan(1);
  });
});
