/**
 * C1 — DEFAULT_STORYBOARD must not contain any face-less preset.
 *
 * HeyGen avatar_iv requires a visible face; face-less shots (e.g.
 * over-the-shoulder) 400 and waste credits on the default flow.
 * Every frame in DEFAULT_STORYBOARD must resolve to a preset whose
 * facePresent flag is true.
 *
 * Pure, zero-network, no DB — runs unconditionally in CI.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_STORYBOARD, SHOT_PRESETS, getPreset, resolvePreset } from './presets.ts';

describe('DEFAULT_STORYBOARD (C1)', () => {
  test('every frame preset resolves to facePresent:true', () => {
    for (const frame of DEFAULT_STORYBOARD.frames) {
      const preset = resolvePreset(frame.preset);
      expect(
        preset.facePresent,
        `preset '${frame.preset}' in DEFAULT_STORYBOARD has facePresent:false`,
      ).toBe(true);
    }
  });

  test('has exactly 4 frames', () => {
    expect(DEFAULT_STORYBOARD.frames).toHaveLength(4);
  });

  test('all 4 frame presets are known (not resolved to fallback via unknown id)', () => {
    for (const frame of DEFAULT_STORYBOARD.frames) {
      expect(
        getPreset(frame.preset),
        `preset '${frame.preset}' is not a known ShotPresetId`,
      ).toBeDefined();
    }
  });
});

describe('SHOT_PRESETS catalogue', () => {
  test('over-shoulder is the only face-less preset', () => {
    const faceless = SHOT_PRESETS.filter((p) => !p.facePresent);
    expect(faceless.map((p) => p.id)).toEqual(['over-shoulder']);
  });

  test('all presets have non-empty framing and defaultAction', () => {
    for (const p of SHOT_PRESETS) {
      expect(p.framing.trim().length, `${p.id}.framing is empty`).toBeGreaterThan(0);
      expect(p.defaultAction.trim().length, `${p.id}.defaultAction is empty`).toBeGreaterThan(0);
    }
  });
});
