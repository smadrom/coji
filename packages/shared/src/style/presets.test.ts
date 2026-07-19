import { describe, expect, it } from 'bun:test';
import {
  STYLE_PRESETS,
  defaultVoiceId,
  localeForStyle,
  resolveGender,
  resolveLocale,
  resolveStyle,
  splitScriptForFrames,
} from './presets.ts';

describe('style presets', () => {
  it('resolves known styles and falls back to american', () => {
    expect(resolveStyle('russian').id).toBe('russian');
    expect(resolveStyle('american').id).toBe('american');
    expect(resolveStyle('nope').id).toBe('american');
    expect(resolveStyle(null).id).toBe('american');
  });

  it('maps style → default locale', () => {
    expect(localeForStyle('american')).toBe('en-US');
    expect(localeForStyle('russian')).toBe('ru-RU');
    expect(localeForStyle(undefined)).toBe('en-US');
  });

  it('every style has a non-empty image preamble', () => {
    for (const s of STYLE_PRESETS) expect(s.imagePreamble.length).toBeGreaterThan(0);
  });
});

describe('locale/gender/voice resolution', () => {
  it('coerces unknown locale/gender to defaults', () => {
    expect(resolveLocale('fr-FR')).toBe('en-US');
    expect(resolveLocale('ru-RU')).toBe('ru-RU');
    expect(resolveGender('nonbinary')).toBe('female');
    expect(resolveGender('male')).toBe('male');
  });

  it('picks a distinct voice per locale + gender', () => {
    const enF = defaultVoiceId('en-US', 'female');
    const enM = defaultVoiceId('en-US', 'male');
    const ruF = defaultVoiceId('ru-RU', 'female');
    const ruM = defaultVoiceId('ru-RU', 'male');
    expect(new Set([enF, enM, ruF, ruM]).size).toBe(4);
    // Unknown inputs fall back to en-US/female.
    expect(defaultVoiceId('xx', 'yy')).toBe(enF);
  });
});

describe('splitScriptForFrames', () => {
  it('returns exactly n non-empty lines for a multi-sentence script', () => {
    const out = splitScriptForFrames('One. Two. Three. Four.', 4);
    expect(out).toHaveLength(4);
    expect(out.every((s) => s.trim().length > 0)).toBe(true);
  });

  it('buckets more sentences than frames without dropping any', () => {
    const out = splitScriptForFrames('A. B. C. D. E. F.', 4);
    expect(out).toHaveLength(4);
    expect(out.join(' ')).toContain('E');
    expect(out.join(' ')).toContain('F');
  });

  it('falls back to word chunks when fewer sentences than frames', () => {
    const out = splitScriptForFrames('alpha beta gamma delta epsilon', 4);
    expect(out).toHaveLength(4);
    expect(out.every((s) => s.trim().length > 0)).toBe(true);
  });

  it('cycles words when there are fewer words than frames', () => {
    const out = splitScriptForFrames('hello world', 4);
    expect(out).toHaveLength(4);
    expect(out.every((s) => s.trim().length > 0)).toBe(true);
  });

  it('returns n empty strings for an empty script', () => {
    expect(splitScriptForFrames('   ', 4)).toEqual(['', '', '', '']);
  });
});
