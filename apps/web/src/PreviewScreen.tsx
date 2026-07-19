/**
 * PreviewScreen — shows the 4 generated frames and the three action buttons:
 *   Cancel → POST /projects/:id/cancel
 *   Retry  → shows prompt-edit field → POST /projects/:id/retry { prompt }
 *   Continue → POST /projects/:id/continue (triggers animation stage)
 *
 * The Continue button shows the animation credit estimate fetched from
 * GET /projects/:id/animation-estimate (wired in #15). Falls back to a
 * static label if the endpoint is not yet available.
 */

import { DEFAULT_STORYBOARD, type Storyboard } from '@coji/shared/storyboard';
import type React from 'react';
import { useEffect, useState } from 'react';
import { StoryboardEditor } from './StoryboardEditor.tsx';
import type { ProjectDetailWithFrames } from './api.ts';
import { ApiError, cancelProject, continueToComposing, openPreview, retryProject } from './api.ts';

interface Props {
  project: ProjectDetailWithFrames;
  onCancelled: () => void;
  onContinued: (projectId: string) => void;
  onRetried: (projectId: string) => void;
}

export function PreviewScreen({ project, onCancelled, onContinued, onRetried }: Props) {
  const [showRetryField, setShowRetryField] = useState(false);
  const [retryPrompt, setRetryPrompt] = useState(project.prompt ?? '');
  const [showShots, setShowShots] = useState(false);
  const [storyboard, setStoryboard] = useState<Storyboard>(
    project.storyboard ?? DEFAULT_STORYBOARD,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRegenerate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await retryProject(project.id, undefined, storyboard);
      onRetried(project.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to re-generate.');
      setBusy(false);
    }
  }

  // Open the preview gate so the FSM is in `awaiting_decision`. Without this,
  // Continue/Retry fail with "Illegal transition images_ready → animating".
  // loadPreview is idempotent (images_ready → awaiting_decision; no-op after).
  useEffect(() => {
    openPreview(project.id).catch(() => {
      /* already open or transient — Continue will surface a real error */
    });
  }, [project.id]);

  async function handleCancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelProject(project.id);
      onCancelled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to cancel.');
      setBusy(false);
    }
  }

  async function handleRetry(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = retryPrompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await retryProject(project.id, trimmed);
      onRetried(project.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to retry.');
      setBusy(false);
    }
  }

  async function handleContinue() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Advance to the COMPOSER step (awaiting_decision → composing), where the
      // user places a VO line per clip and composes N clips from the 4 frames.
      // The paid animate (with its credit cost) happens from the composer, not here.
      await continueToComposing(project.id);
      onContinued(project.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to continue.');
      setBusy(false);
    }
  }

  const continueLabel = 'Continue → add your lines';

  return (
    <div className="page">
      <div className="card" style={{ maxWidth: '720px' }}>
        <div>
          <h1 className="card-title">Your frames are ready</h1>
          <p className="card-subtitle">
            Review the generated frames. Continue to add your voice-over lines per clip, retry with
            a new prompt, or cancel.
          </p>
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        <div className="frame-grid">
          {([0, 1, 2, 3] as const).map((slotIdx) => {
            const frame = project.frames?.find((f) => f.idx === slotIdx);
            return (
              <div key={`slot-${slotIdx}`} className="frame-card">
                <div className="frame-card__img-wrap">
                  {frame?.signedUrl ? (
                    <img
                      src={frame.signedUrl}
                      alt={`Frame ${slotIdx + 1}`}
                      loading="lazy"
                      data-testid="frame-thumb"
                    />
                  ) : (
                    <div className="frame-card__status">
                      <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
                        Frame {slotIdx + 1}
                      </span>
                    </div>
                  )}
                </div>
                {frame?.caption && <div className="frame-card__caption">{frame.caption}</div>}
              </div>
            );
          })}
        </div>

        {showShots && (
          <div className="retry-field">
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)' }}>
              Adjust the shots, then re-generate the 4 frames.
            </span>
            <StoryboardEditor value={storyboard} onChange={setStoryboard} disabled={busy} />
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRegenerate}
                disabled={busy}
                data-testid="regenerate"
              >
                {busy ? (
                  <>
                    <span className="spinner" style={{ fontSize: '0.8rem' }} /> Re-generating…
                  </>
                ) : (
                  'Re-generate frames'
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowShots(false)}
                disabled={busy}
              >
                Close
              </button>
            </div>
          </div>
        )}

        {showRetryField && (
          <form className="retry-field" onSubmit={handleRetry}>
            <label htmlFor="retry-prompt">Edit your prompt</label>
            <textarea
              id="retry-prompt"
              rows={3}
              value={retryPrompt}
              onChange={(e) => setRetryPrompt(e.target.value)}
              disabled={busy}
              required
            />
            <div className="btn-row">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !retryPrompt.trim()}
              >
                {busy ? (
                  <>
                    <span className="spinner" style={{ fontSize: '0.8rem' }} /> Retrying…
                  </>
                ) : (
                  'Retry with this prompt'
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowRetryField(false)}
                disabled={busy}
              >
                Cancel edit
              </button>
            </div>
          </form>
        )}

        <div className="btn-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div className="btn-row">
            <button type="button" className="btn btn-danger" onClick={handleCancel} disabled={busy}>
              Cancel project
            </button>
            {!showRetryField && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowRetryField(true)}
                disabled={busy}
              >
                Retry prompt
              </button>
            )}
            {!showShots && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowShots(true)}
                disabled={busy}
                data-testid="adjust-shots"
              >
                Adjust shots
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleContinue}
            disabled={busy}
          >
            {busy ? (
              <>
                <span className="spinner" style={{ fontSize: '0.8rem' }} /> Working…
              </>
            ) : (
              continueLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
