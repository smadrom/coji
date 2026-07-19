/**
 * ComposerScreen — the "Build from beats" step between the preview gate
 * (awaiting_decision → composing) and the animation stage.
 *
 * Shown when project.status === 'composing'. The user assembles a list of
 * beats; each beat = one of the project's 4 reusable frames + a VO line +
 * an order position. The same frame may back multiple beats ("×N used" badge).
 *
 * Key behaviours:
 *   - Auto-seeds from the project's script via a simple line-split so the
 *     user isn't staring at an empty list on first open.
 *   - Debounced PUT /composition save (B1 pattern) — the draft persists on
 *     reload without an explicit save button.
 *   - Live credit cost on the CTA: "Animate N clips → N × perClip credits"
 *     (E2 cost-before-paid pattern via GET /animation-estimate).
 *   - Per-beat status chips + "↻ Regenerate" for already-animated beats (C2).
 *   - Drag-reorder (HTML drag-and-drop, same idiom as the editor timeline).
 *   - Frame picker: 4-up thumbnail strip; click to choose; "×N used" badge.
 *   - Empty/loading/error states per the UX analysis.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type ClipComposerEntry,
  type ClipRow,
  type FrameRow,
  type ProjectDetailWithFrames,
  continueProject,
  getAnimationEstimate,
  getComposition,
  reanimateClip,
  setComposition,
} from './api.ts';

interface Props {
  project: ProjectDetailWithFrames;
  /** Called after the "Animate N clips" CTA succeeds (project enters animating). */
  onContinued: () => void;
  /** Called on the "← Back" button — returns to the dispatcher (re-fetches). */
  onBack: () => void;
}

// Debounce window for auto-saving the composition draft.
const COMPOSE_SAVE_DEBOUNCE_MS = 800;

/** A local beat row (superset of ClipComposerEntry with UI-only fields). */
interface Beat {
  /** undefined for a new beat not yet assigned a server-side clip id. */
  clipId?: string;
  sourceFrameId: string;
  script: string;
  /** Client-only drag key — stable across reorders. */
  key: string;
  /** Server-reported clip status (undefined until the beat has been animated). */
  status?: ClipRow['status'];
}

let keyCounter = 0;
function nextKey() {
  return `beat-${++keyCounter}`;
}

/**
 * Split a script into per-beat lines. Trims blanks; returns at most
 * MAX_AUTO_SEED beats. An empty script produces a single blank beat.
 */
const MAX_AUTO_SEED = 9;
function splitScript(script: string | null | undefined): string[] {
  if (!script?.trim()) return [''];
  const lines = script
    .split(/\n|\.(?=\s)/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.slice(0, MAX_AUTO_SEED) : [''];
}

/**
 * Map a server ClipViewDto list back to Beat rows (used to hydrate from a
 * saved draft on load). Preserves order_idx order (already guaranteed by the
 * API). The current ClipViewDto does not expose the backing frame id, so we
 * cycle through the available frames by position as a display default — the
 * user can re-pick the frame, and PUT /composition updates the frame correctly
 * when they do (the clipId update path preserves the current frame until
 * explicitly changed).
 */
function hydrateBeats(clips: ClipRow[], frames: FrameRow[]): Beat[] {
  if (clips.length === 0 || frames.length === 0) return [];
  return clips.map((c, i) => ({
    clipId: c.id,
    // Prefer the real backing frame id (now returned by the API); fall back to a
    // round-robin placeholder only for legacy rows that predate sourceFrameId.
    sourceFrameId: c.sourceFrameId ?? frames[i % frames.length]?.id ?? frames[0]?.id ?? '',
    script: c.script,
    key: nextKey(),
    status: c.status,
  }));
}

const EMPTY_FRAMES: FrameRow[] = [];

function sigOf(bs: Beat[]): string {
  return bs.map((b) => `${b.clipId ?? ''}:${b.sourceFrameId}:${b.script}`).join('|');
}

export function ComposerScreen({ project, onContinued, onBack }: Props) {
  const frames: FrameRow[] = project.frames ?? EMPTY_FRAMES;
  const firstFrameId = frames[0]?.id ?? '';
  const projectId = project.id;
  const projectScript = (project as { script?: string | null }).script ?? null;
  const storyboardScenes = (
    project as {
      storyboardScenes?: Array<{
        idx: number;
        voLine: string;
        suggestedFrameIdx: number;
      }> | null;
    }
  ).storyboardScenes;

  // ---- beat list state ----
  const [beats, setBeats] = useState<Beat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- credit estimate ----
  const [perClipCredits, setPerClipCredits] = useState<number | null>(null);

  // ---- save state ----
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last-persisted signature — prevents a redundant save on hydration.
  const lastSavedSigRef = useRef<string | null>(null);

  // ---- animate CTA ----
  const [busy, setBusy] = useState(false);
  const [animateError, setAnimateError] = useState<string | null>(null);

  // ---- per-beat regenerate ----
  const [reanimatingId, setReanimatingId] = useState<string | null>(null);
  const [reanimateError, setReanimateError] = useState<string | null>(null);

  // ---- drag-reorder ----
  const dragKeyRef = useRef<string | null>(null);

  // ---- Load saved draft (or auto-seed from project.script) ----
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    getComposition(projectId)
      .then((clips) => {
        if (cancelled) return;
        if (clips.length > 0) {
          // Server has a draft — hydrate it.
          const hydrated = hydrateBeats(clips, frames);
          if (hydrated.length > 0) {
            setBeats(hydrated);
            // Record the current sig as baseline so the first render doesn't
            // trigger an immediate save back to the server.
            lastSavedSigRef.current = sigOf(hydrated);
            setLoaded(true);
            return;
          }
        }
        // No saved draft. Prefer storyboard scenes (storyboard input mode): each
        // scene becomes one beat with its VO line + LLM-suggested frame.
        if (storyboardScenes && storyboardScenes.length > 0) {
          const seeded: Beat[] = storyboardScenes.map((scene) => ({
            sourceFrameId: frames[scene.suggestedFrameIdx]?.id ?? firstFrameId,
            script: scene.voLine,
            key: nextKey(),
          }));
          setBeats(seeded);
          lastSavedSigRef.current = null;
          setLoaded(true);
          return;
        }

        // Fallback: seed from the project's VO SCRIPT (one beat per line)
        // when one was entered — NOT the prompt (the prompt is the scene/setting
        // description, never a spoken line). With no script, start with a single
        // empty beat so the user types their own lines.
        const lines = projectScript?.trim() ? splitScript(projectScript) : [];
        const seeded: Beat[] = lines.map((line) => ({
          sourceFrameId: firstFrameId,
          script: line,
          key: nextKey(),
        }));
        setBeats(seeded.length > 0 ? seeded : [newBeat(firstFrameId)]);
        lastSavedSigRef.current = null; // seeded draft is unsaved — allow first save
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : 'Could not load composition.');
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [firstFrameId, frames, projectId, projectScript, storyboardScenes]);

  // ---- Fetch per-clip credit cost (for the live CTA label) ----
  useEffect(() => {
    let cancelled = false;
    getAnimationEstimate(projectId)
      .then((est) => {
        if (!cancelled) {
          // The estimate returns the TOTAL for the current clip count; we want
          // the per-clip unit so we can show "N × perClip". Fall back to null
          // (hides the cost breakdown) if the beat count would be 0.
          const n = beats.length || 1;
          setPerClipCredits(Math.round(est.credits / n));
        }
      })
      .catch(() => {
        if (!cancelled) setPerClipCredits(null);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch whenever beat count changes (cost scales with N).
  }, [projectId, beats.length]);

  // ---- Debounced save ----
  // Flush timer on unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const scheduleSave = useCallback(
    (bs: Beat[]) => {
      if (!loaded) return;
      const sig = sigOf(bs);
      if (lastSavedSigRef.current === sig) return; // unchanged
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        setSaveState('saving');
        try {
          const entries: ClipComposerEntry[] = bs.map((b, i) => ({
            clipId: b.clipId,
            sourceFrameId: b.sourceFrameId,
            script: b.script,
            orderIdx: i,
          }));
          const fresh = await setComposition(projectId, entries);
          // Merge minted clip ids back into local beats so subsequent saves
          // use the update path (clipId present) rather than re-inserting.
          setBeats((prev) =>
            prev.map((b, i) => ({
              ...b,
              clipId: fresh[i]?.id ?? b.clipId,
              status: (fresh[i] as ClipRow | undefined)?.status ?? b.status,
            })),
          );
          lastSavedSigRef.current = sig;
          setSaveState('saved');
        } catch {
          setSaveState('error');
        }
      }, COMPOSE_SAVE_DEBOUNCE_MS);
    },
    [loaded, projectId],
  );

  // ---- Beat mutations (all trigger a debounced save) ----
  function updateBeats(next: Beat[]) {
    setBeats(next);
    scheduleSave(next);
  }

  function newBeat(frameId: string, script = ''): Beat {
    return { sourceFrameId: frameId, script, key: nextKey() };
  }

  function handleAddBeat() {
    const last = beats[beats.length - 1];
    const frameId = last?.sourceFrameId ?? firstFrameId;
    updateBeats([...beats, newBeat(frameId)]);
  }

  function handleRemoveBeat(key: string) {
    updateBeats(beats.filter((b) => b.key !== key));
  }

  function handleScriptChange(key: string, value: string) {
    updateBeats(beats.map((b) => (b.key === key ? { ...b, script: value } : b)));
  }

  function handleFramePick(key: string, frameId: string) {
    updateBeats(beats.map((b) => (b.key === key ? { ...b, sourceFrameId: frameId } : b)));
  }

  // ---- Drag-reorder (same HTML DnD idiom as EditorScreen) ----
  function handleDragStart(key: string, e: React.DragEvent) {
    dragKeyRef.current = key;
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(key: string, e: React.DragEvent) {
    if (dragKeyRef.current && dragKeyRef.current !== key) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDrop(key: string, e: React.DragEvent) {
    e.preventDefault();
    const from = dragKeyRef.current;
    dragKeyRef.current = null;
    if (!from || from === key) return;
    const fromIdx = beats.findIndex((b) => b.key === from);
    const toIdx = beats.findIndex((b) => b.key === key);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...beats];
    const [moved] = next.splice(fromIdx, 1);
    if (moved) next.splice(toIdx, 0, moved);
    updateBeats(next);
  }

  // ---- Animate CTA ----
  async function handleAnimate() {
    if (busy || beats.length === 0) return;
    setBusy(true);
    setAnimateError(null);
    try {
      // Flush any pending debounce first so the server has the latest draft.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const entries: ClipComposerEntry[] = beats.map((b, i) => ({
        clipId: b.clipId,
        sourceFrameId: b.sourceFrameId,
        script: b.script,
        orderIdx: i,
      }));
      await setComposition(project.id, entries);
      // Transition composing → animating.
      await continueProject(project.id);
      onContinued();
    } catch (err) {
      setAnimateError(
        err instanceof ApiError ? err.message : 'Could not start animation. Please try again.',
      );
      setBusy(false);
    }
  }

  // ---- Per-beat regenerate (C2) ----
  async function handleReanimate(clipId: string) {
    if (reanimatingId) return;
    setReanimatingId(clipId);
    setReanimateError(null);
    try {
      await reanimateClip(project.id, clipId);
      onBack(); // dispatcher re-routes to AnimatingScreen
    } catch (err) {
      setReanimatingId(null);
      setReanimateError(
        err instanceof ApiError ? err.message : 'Could not start re-animation. Please try again.',
      );
    }
  }

  // ---- Frame use-count map (for "×N used" badges) ----
  const frameUseCounts: Record<string, number> = {};
  for (const b of beats) {
    frameUseCounts[b.sourceFrameId] = (frameUseCounts[b.sourceFrameId] ?? 0) + 1;
  }

  // ---- Derived CTA label ----
  const n = beats.length;
  const totalCost = perClipCredits != null ? n * perClipCredits : null;
  const ctaLabel = (() => {
    if (busy) return 'Starting animation…';
    if (n === 0) return 'Add at least one beat';
    if (totalCost != null) return `Animate ${n} clip${n !== 1 ? 's' : ''} → ${totalCost} credits`;
    return `Animate ${n} clip${n !== 1 ? 's' : ''}`;
  })();

  // ---- Frames still loading ----
  const framesReady = frames.some((f) => f.status === 'ready' && f.signedUrl);

  // ---- Loading skeleton ----
  if (!loaded) {
    return (
      <div className="page">
        <div className="card" style={{ alignItems: 'center' }}>
          <span className="spinner" style={{ fontSize: '1.5rem', color: 'var(--color-accent)' }} />
          <p className="card-subtitle">Loading composition…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page" style={{ alignItems: 'stretch', justifyContent: 'flex-start' }}>
      <div
        className="card"
        style={{ maxWidth: '760px', margin: '0 auto', width: '100%', gap: '1.25rem' }}
      >
        {/* Header */}
        <div>
          <h1 className="card-title">Add your lines</h1>
          <p className="card-subtitle">
            Each beat = one clip. For every beat: <b>pick one shot</b> (tap a thumbnail — the
            selected one gets a ✓) and <b>type the spoken line</b>. Add a beat per line of your
            script; the same shot can be reused across beats. Drag ⠿ to reorder. Then “Animate”.
          </p>
        </div>

        {loadError && <div className="banner banner-error">{loadError}</div>}
        {animateError && <div className="banner banner-error">{animateError}</div>}
        {reanimateError && (
          <div className="banner banner-error" style={{ fontSize: '0.85rem' }}>
            {reanimateError}
          </div>
        )}

        {/* Frames not ready yet */}
        {!framesReady && (
          <div className="banner banner-info" style={{ fontSize: '0.85rem' }}>
            <span className="spinner" style={{ fontSize: '0.75rem' }} /> Frames are still generating
            — you can author beats now; thumbnails will appear once ready.
          </div>
        )}

        {/* Beat list */}
        {beats.length === 0 ? (
          <div
            className="banner banner-info"
            style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}
          >
            <span>No beats yet.</span>
            <button type="button" className="btn btn-ghost" onClick={handleAddBeat}>
              + Add beat
            </button>
          </div>
        ) : (
          <ol className="composer-beat-list">
            {beats.map((beat, i) => (
              <li
                key={beat.key}
                className="composer-beat"
                draggable
                onDragStart={(e) => handleDragStart(beat.key, e)}
                onDragOver={(e) => handleDragOver(beat.key, e)}
                onDrop={(e) => handleDrop(beat.key, e)}
                onDragEnd={() => {
                  dragKeyRef.current = null;
                }}
              >
                {/* Row header: index + drag handle + status chip + remove */}
                <div className="composer-beat__header">
                  <span className="composer-beat__drag" aria-hidden="true" title="Drag to reorder">
                    ⠿
                  </span>
                  <span className="composer-beat__index">{i + 1}</span>
                  {beat.status && beat.status !== 'pending' && (
                    <span
                      className={`composer-beat__chip composer-beat__chip--${beat.status}`}
                      title={`Clip status: ${beat.status}`}
                    >
                      {beat.status === 'animating' ? (
                        <>
                          <span className="spinner" style={{ fontSize: '0.65rem' }} /> animating
                        </>
                      ) : beat.status === 'completed' ? (
                        '✓ done'
                      ) : beat.status === 'failed' ? (
                        '✗ failed'
                      ) : (
                        beat.status
                      )}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {/* Re-animate button for failed beats (C2) */}
                  {beat.status === 'failed' && beat.clipId && (
                    <button
                      type="button"
                      className="btn btn-ghost composer-beat__reanimate"
                      onClick={() => beat.clipId && handleReanimate(beat.clipId)}
                      disabled={reanimatingId != null}
                      title="Re-animate this clip"
                    >
                      {reanimatingId === beat.clipId ? (
                        <>
                          <span className="spinner" style={{ fontSize: '0.7rem' }} /> Starting…
                        </>
                      ) : (
                        '↻ Regenerate'
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="composer-beat__remove"
                    onClick={() => handleRemoveBeat(beat.key)}
                    aria-label={`Remove beat ${i + 1}`}
                    title="Remove beat"
                    disabled={busy}
                  >
                    ✕
                  </button>
                </div>

                {/* Frame picker — 4-up thumbnail strip; pick ONE shot per beat */}
                <span className="composer-beat__label">Shot for this clip</span>
                <div className="composer-frame-picker" aria-label="Choose one shot">
                  {frames.map((frame) => {
                    // Guard against empty ids (frames mid-generation): only a
                    // real, matching id counts as selected — otherwise an empty
                    // sourceFrameId would "match" every empty frame id at once.
                    const active = !!frame.id && beat.sourceFrameId === frame.id;
                    const useCount = frameUseCounts[frame.id] ?? 0;
                    return (
                      <button
                        key={frame.id}
                        type="button"
                        aria-pressed={active}
                        className={`composer-frame-thumb${active ? ' composer-frame-thumb--active' : ''}`}
                        onClick={() => handleFramePick(beat.key, frame.id)}
                        aria-label={`Shot ${frame.idx + 1}${active ? ' (selected)' : ''}`}
                        title={
                          active ? `Shot ${frame.idx + 1} (selected)` : `Use shot ${frame.idx + 1}`
                        }
                        disabled={busy}
                      >
                        {frame.signedUrl ? (
                          <img
                            src={frame.signedUrl}
                            alt={`Frame ${frame.idx + 1}`}
                            loading="lazy"
                          />
                        ) : (
                          <span
                            style={{
                              fontSize: 'var(--fs-xs)',
                              color: 'var(--color-text-muted)',
                            }}
                          >
                            {frame.idx + 1}
                          </span>
                        )}
                        {/* Bright check on the SELECTED shot (one per beat). */}
                        {active && (
                          <span className="composer-frame-thumb__check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                        {/* "×N used" badge when frame is reused across multiple beats */}
                        {useCount > 1 && (
                          <span className="composer-frame-thumb__badge">×{useCount}</span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* VO line textarea */}
                <span className="composer-beat__label">Spoken line</span>
                <textarea
                  className="composer-beat__script"
                  rows={2}
                  placeholder="What does she say in this clip? e.g. “Okay I need to tell you about this app…”"
                  value={beat.script}
                  onChange={(e) => handleScriptChange(beat.key, e.target.value)}
                  disabled={busy}
                  aria-label={`Beat ${i + 1} spoken line`}
                />
              </li>
            ))}
          </ol>
        )}

        {/* "+ Add beat" */}
        <button
          type="button"
          className="btn btn-ghost composer-add-beat"
          onClick={handleAddBeat}
          disabled={busy || beats.length >= 20}
          title={beats.length >= 20 ? 'Maximum 20 beats per project' : undefined}
        >
          + Add beat
          {beats.length >= 20 && (
            <span
              style={{
                marginLeft: '0.4em',
                color: 'var(--color-text-muted)',
                fontSize: 'var(--fs-xs)',
              }}
            >
              (max 20)
            </span>
          )}
        </button>

        {/* Save status */}
        <span
          className="composer-save-status"
          aria-live="polite"
          style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)', minHeight: '1.2em' }}
        >
          {saveState === 'saving' ? (
            <>
              <span className="spinner" style={{ fontSize: '0.65rem' }} /> Saving draft…
            </>
          ) : saveState === 'saved' ? (
            'Draft saved'
          ) : saveState === 'error' ? (
            <span style={{ color: 'var(--color-danger)' }}>Couldn't save draft</span>
          ) : null}
        </span>

        {/* CTA row */}
        <div className="btn-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy}>
            ← Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleAnimate}
            disabled={busy || beats.length === 0}
          >
            {busy ? (
              <>
                <span className="spinner" style={{ fontSize: '0.8rem' }} /> {ctaLabel}
              </>
            ) : (
              ctaLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
