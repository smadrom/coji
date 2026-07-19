/**
 * PromptScreen — create a project and kick off image generation.
 *
 * Flow:
 *  1. User enters a prompt.
 *  2. "Generate" button → POST /projects (creates draft) → POST /projects/:id/generate-images (202).
 *  3. On success, calls onStarted(projectId) so the parent mounts GeneratingScreen.
 *
 * Shows the image-stage credit cost before the button (hardcoded to 4 credits
 * for v1; the API will return this once #14 adds it to the response).
 */

import { DEFAULT_STORYBOARD, type Storyboard } from '@coji/shared/storyboard';
import {
  GENDERS,
  type Gender,
  LOCALES,
  type Locale,
  STYLE_PRESETS,
  type StyleId,
  localeForStyle,
} from '@coji/shared/style';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StoryboardEditor } from './StoryboardEditor.tsx';
import {
  ApiError,
  BASE_URL,
  type ParsedScene,
  type Voice,
  authHeaders,
  generateImages,
  listVoices,
  parseStoryboard,
} from './api.ts';

interface Props {
  onStarted: (projectId: string) => void;
}

// v1: 4 frames × 1 credit each (matches the plan's per_set pricing).
const IMAGE_CREDIT_COST = 4;

const LOCALE_LABELS: Record<Locale, string> = {
  'en-US': 'English (US)',
  'ru-RU': 'Russian',
};

export function PromptScreen({ onStarted }: Props) {
  const [mode, setMode] = useState<'simple' | 'storyboard'>('simple');
  const [quality, setQuality] = useState<'draft' | 'max'>('max');
  const [prompt, setPrompt] = useState('');
  const [storyboardText, setStoryboardText] = useState('');
  const [storyboard, setStoryboard] = useState<Storyboard>(DEFAULT_STORYBOARD);
  const [style, setStyle] = useState<StyleId>('american');
  const [locale, setLocale] = useState<Locale>('en-US');
  const [gender, setGender] = useState<Gender>('female');
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseStatus, setParseStatus] = useState<string | null>(null);

  // Voice picker (D1). Catalog fetched once; the user picks + previews a voice.
  // `voiceTouched` tracks a manual pick so locale/gender changes only re-default
  // the selection while the user hasn't chosen one explicitly.
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceTouched, setVoiceTouched] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Fetch the voice catalog once. Degrades gracefully: on failure the picker is
  // hidden and the API falls back to the locale/gender default voice at create.
  useEffect(() => {
    let cancelled = false;
    listVoices()
      .then((list) => {
        if (!cancelled) setVoices(list);
      })
      .catch(() => {
        if (!cancelled) setVoices([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Voices matching the current locale (and, when possible, the chosen gender).
  const localeVoices = useMemo(() => {
    const byLocale = voices.filter((v) => v.locale === locale);
    const base = byLocale.length > 0 ? byLocale : voices;
    const byGender = base.filter((v) => !v.gender || v.gender === gender);
    return byGender.length > 0 ? byGender : base;
  }, [voices, locale, gender]);

  // Default-select a sensible voice for the locale/gender until the user picks
  // one. Re-defaults when locale/gender changes (unless manually touched).
  useEffect(() => {
    if (voiceTouched) return;
    setVoiceId(localeVoices[0]?.id ?? null);
  }, [localeVoices, voiceTouched]);

  // Stop any in-flight preview when the component unmounts.
  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
    };
  }, []);

  function handlePreview(voice: Voice) {
    if (!voice.previewUrl) return;
    // Toggle off if the same preview is playing.
    if (previewingId === voice.id) {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
      setPreviewingId(null);
      return;
    }
    previewAudioRef.current?.pause();
    const audio = new Audio(voice.previewUrl);
    previewAudioRef.current = audio;
    setPreviewingId(voice.id);
    audio.onended = () => setPreviewingId((cur) => (cur === voice.id ? null : cur));
    audio.onerror = () => setPreviewingId((cur) => (cur === voice.id ? null : cur));
    void audio.play().catch(() => setPreviewingId((cur) => (cur === voice.id ? null : cur)));
  }

  // Changing the style nudges the locale to that style's default (american→en-US,
  // russian→ru-RU); the user can still override the locale afterward.
  function handleStyleChange(next: StyleId) {
    setStyle(next);
    setLocale(localeForStyle(next));
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    setParseStatus(null);

    try {
      let finalPrompt = prompt.trim();
      let parsedScenes: ParsedScene[] | undefined;

      // Storyboard mode: parse first, derive image prompt + scenes from LLM.
      if (mode === 'storyboard') {
        const rawText = storyboardText.trim();
        if (!rawText) {
          setError('Paste your storyboard text first.');
          setBusy(false);
          return;
        }
        setParseStatus('Analyzing storyboard…');
        const parsed = await parseStoryboard(rawText);
        setParseStatus('Generating frames…');
        finalPrompt = parsed.imagePrompt;
        parsedScenes = parsed.scenes;
      }

      if (!finalPrompt) {
        setError('Prompt is required.');
        setBusy(false);
        return;
      }

      // Step 1 — create project (draft)
      const createRes = await fetch(`${BASE_URL}/projects`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: finalPrompt,
          audioMode: 'tts',
          style,
          locale,
          gender,
          // Chosen voice (persisted as projects.voice_id). Omitted → API derives
          // the locale/gender default.
          voiceId: voiceId ?? undefined,
          script: script.trim() ? script.trim() : undefined,
          storyboard,
          storyboardScenes: parsedScenes ?? undefined,
          quality,
        }),
      });

      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(createRes.status, body.error ?? createRes.statusText);
      }

      const project = (await createRes.json()) as { id: string };

      // Step 2 — trigger image generation (202 accepted)
      await generateImages(project.id);

      onStarted(project.id);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.isUnauthorized) {
          setError('Authentication required. Check your API token.');
        } else if (err.isInsufficientCredits) {
          setError('Insufficient credits. Please top up your balance.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <form className="card" onSubmit={handleGenerate}>
        <div>
          <h1 className="card-title">Create your video</h1>
          <p className="card-subtitle">
            Describe the scene and we'll generate 4 consistent frames, then animate them into clips.
          </p>
        </div>

        {/* Mode tabs */}
        <div className="mode-tabs" role="tablist" aria-label="Input mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'simple'}
            className={`mode-tab${mode === 'simple' ? ' mode-tab--active' : ''}`}
            onClick={() => setMode('simple')}
            disabled={busy}
          >
            Simple
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'storyboard'}
            className={`mode-tab${mode === 'storyboard' ? ' mode-tab--active' : ''}`}
            onClick={() => setMode('storyboard')}
            disabled={busy}
          >
            Storyboard
          </button>
        </div>

        {mode === 'simple' ? (
          <textarea
            rows={4}
            data-testid="prompt-input"
            placeholder="e.g. A confident woman in a modern office, speaking to the camera, professional lighting, cinematic"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
            required
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span
              className="storyboard__field"
              style={{ fontWeight: 500, fontSize: 'var(--fs-sm)' }}
            >
              Paste your storyboard (Setting + scene table)
            </span>
            <textarea
              rows={12}
              data-testid="storyboard-text-input"
              placeholder={
                '**Setting:** Woman, 35–45. Sitting at a kitchen table. Morning vibe. Coffee mug nearby.\n\n| # | Time | VO (exact line) | Avatar Action |\n|---|------|-----------------|---------------|\n| 1 | 0–7s | «Okay I need to tell you…» | Leans toward camera |\n| 2 | 7–14s | «So basically you download it…» | Holds phone up |'
              }
              value={storyboardText}
              onChange={(e) => setStoryboardText(e.target.value)}
              disabled={busy}
              style={{ fontFamily: 'monospace', fontSize: 'var(--fs-xs)' }}
            />
            {parseStatus && (
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>
                <span className="spinner" style={{ fontSize: '0.65rem' }} /> {parseStatus}
              </span>
            )}
          </div>
        )}

        <div className="style-locale" data-testid="style-locale">
          <label className="storyboard__field">
            <span>Style</span>
            <select
              value={style}
              onChange={(e) => handleStyleChange(e.target.value as StyleId)}
              disabled={busy}
              data-testid="style-select"
            >
              {STYLE_PRESETS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="storyboard__field">
            <span>Voice language</span>
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              disabled={busy}
              data-testid="locale-select"
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
          <label className="storyboard__field">
            <span>Presenter</span>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as Gender)}
              disabled={busy}
              data-testid="gender-select"
            >
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g === 'female' ? 'Woman' : 'Man'}
                </option>
              ))}
            </select>
          </label>
        </div>

        {localeVoices.length > 0 && (
          <div className="voice-picker" data-testid="voice-picker">
            <label className="storyboard__field" style={{ flex: 1 }}>
              <span>Voice</span>
              <select
                value={voiceId ?? ''}
                onChange={(e) => {
                  setVoiceId(e.target.value);
                  setVoiceTouched(true);
                }}
                disabled={busy}
                data-testid="voice-select"
              >
                {localeVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.gender ? ` · ${v.gender === 'female' ? 'Woman' : 'Man'}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {(() => {
              const selected = localeVoices.find((v) => v.id === voiceId);
              if (!selected?.previewUrl) return null;
              return (
                <button
                  type="button"
                  className="btn btn-ghost voice-picker__preview"
                  onClick={() => handlePreview(selected)}
                  disabled={busy}
                  aria-label={`Preview voice ${selected.name}`}
                  title="Preview this voice"
                >
                  {previewingId === selected.id ? '❚❚ Stop' : '▶ Preview'}
                </button>
              );
            })()}
          </div>
        )}

        <label className="storyboard__field">
          <span>Voiceover script (optional — defaults to your prompt)</span>
          <textarea
            rows={3}
            data-testid="script-input"
            placeholder="What the presenter says, in the chosen language. You can edit lines in the clip composer."
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={busy}
          />
        </label>

        <StoryboardEditor value={storyboard} onChange={setStoryboard} disabled={busy} />

        {/* Quality mode toggle */}
        <fieldset className="quality-toggle" aria-label="Image quality">
          <legend className="quality-toggle__label">Quality</legend>
          <div className="mode-tabs" style={{ width: 'fit-content' }}>
            <button
              type="button"
              aria-pressed={quality === 'draft'}
              className={`mode-tab${quality === 'draft' ? ' mode-tab--active' : ''}`}
              onClick={() => setQuality('draft')}
              disabled={busy}
              title="Faster & cheaper — good for testing"
            >
              Draft
            </button>
            <button
              type="button"
              aria-pressed={quality === 'max'}
              className={`mode-tab${quality === 'max' ? ' mode-tab--active' : ''}`}
              onClick={() => setQuality('max')}
              disabled={busy}
              title="Best quality — use for final videos"
            >
              Max
            </button>
          </div>
        </fieldset>

        {error && <div className="banner banner-error">{error}</div>}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '0.5rem',
          }}
        >
          <span className="credit-hint">
            <span className="spinner" style={{ opacity: busy ? 1 : 0, fontSize: '0.75rem' }} />
            Cost: <strong>{IMAGE_CREDIT_COST} credits</strong>
          </span>
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="generate-button"
            disabled={
              busy ||
              (mode === 'simple' ? prompt.trim().length === 0 : storyboardText.trim().length === 0)
            }
          >
            {busy ? (
              <>
                <span className="spinner" style={{ fontSize: '0.85rem' }} />
                Starting…
              </>
            ) : (
              'Generate frames'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
