/**
 * ProjectScreen — route `/p/:id`. Status dispatcher over the existing stage
 * sub-views (Generating / Preview / Animating / Editor / Done / Error).
 *
 * Loads the project once, then renders the sub-view matching its FSM status.
 * The sub-views keep their own stage polling and logic unchanged — we only
 * translate their transition callbacks into a re-fetch (`reload`) so the
 * dispatcher advances to the next stage. A "← Gallery" back link is shown on
 * every stage.
 *
 * Deep-link safe: a direct hit on /p/:id fetches fresh state; the auth gate in
 * App ensures an unauthenticated visitor sees SignIn, never a blank screen.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

// Approximate dollar value (5 cents per credit).
const CREDIT_USD = 0.05;

/** Stacked horizontal bar showing image / animation / render credit breakdown. */
function CostBreakdown({ total, rendered }: { total: number; rendered: boolean }) {
  if (total <= 0) return null;
  const imageCr = Math.min(5, total);
  const renderCr = rendered ? Math.min(10, Math.max(0, total - imageCr)) : 0;
  const animCr = Math.max(0, total - imageCr - renderCr);
  const usd = (total * CREDIT_USD).toFixed(2);
  const segments = [
    { label: 'Images', credits: imageCr, color: 'var(--color-accent, #6c63ff)' },
    { label: 'Animation', credits: animCr, color: '#e05c9a' },
    { label: 'Render', credits: renderCr, color: '#22c55e' },
  ].filter((s) => s.credits > 0);
  return (
    <div className="cost-breakdown">
      <div className="cost-breakdown__title">
        Project cost — <strong>{total} credits</strong> (~${usd})
      </div>
      <div className="cost-breakdown__bar">
        {segments.map((s) => (
          <div
            key={s.label}
            className="cost-breakdown__segment"
            style={{ flex: s.credits, background: s.color }}
            title={`${s.label}: ${s.credits} cr`}
          />
        ))}
      </div>
      <div className="cost-breakdown__legend">
        {segments.map((s) => (
          <span key={s.label} className="cost-breakdown__legend-item">
            <span className="cost-breakdown__dot" style={{ background: s.color }} />
            {s.label} {s.credits} cr
          </span>
        ))}
      </div>
    </div>
  );
}
import { AnimatingScreen } from './AnimatingScreen.tsx';
import { ComposerScreen } from './ComposerScreen.tsx';
import { EditorScreen } from './EditorScreen.tsx';
import { GeneratingScreen } from './GeneratingScreen.tsx';
import { PreviewScreen } from './PreviewScreen.tsx';
import { ApiError, type ProjectDetailWithFrames, getProject } from './api.ts';
import { ReEditButton } from './components/ReEditButton.tsx';
import { ShareButton } from './components/ShareButton.tsx';
import { Button } from './components/ui.tsx';

/** Coarse stage buckets derived from the FSM status. */
type Stage = 'generating' | 'preview' | 'composing' | 'animating' | 'editor' | 'done' | 'error';

function stageFor(status: string): Stage {
  switch (status) {
    case 'draft':
    case 'generating_images':
    case 'images_pending':
      return 'generating';
    case 'images_ready':
    case 'awaiting_decision':
      return 'preview';
    case 'composing':
      return 'composing';
    case 'animating':
      return 'animating';
    case 'clips_ready':
    case 'editing':
    case 'rendering':
      return 'editor';
    case 'rendered':
    case 'done':
      return 'done';
    default:
      return 'error';
  }
}

function BackLink() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="back-link"
      data-testid="back-to-gallery"
      onClick={() => navigate('/')}
    >
      ← Gallery
    </button>
  );
}

export function ProjectScreen({ refreshBalance }: { refreshBalance: () => void }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetailWithFrames | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped to force a fresh fetch (and thus a stage re-evaluation).
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional trigger; bumping it re-fetches the project to advance the stage
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setProject(null);
    setLoadError(null);
    getProject(id)
      .then((p) => {
        if (!cancelled) setProject(p);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.isNotFound) {
          setLoadError('Project not found.');
        } else if (err instanceof ApiError && err.isUnauthorized) {
          setLoadError('Authentication required.');
        } else {
          setLoadError(err instanceof Error ? err.message : 'Could not load project.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (!id) return null;

  if (loadError) {
    return (
      <div className="page">
        <div className="card">
          <BackLink />
          <h1 className="card-title">Something went wrong</h1>
          <div className="banner banner-error">{loadError}</div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="page">
        <div className="card" style={{ alignItems: 'center' }}>
          <span className="spinner" style={{ fontSize: '1.5rem', color: 'var(--color-accent)' }} />
          <p className="card-subtitle">Loading project…</p>
        </div>
      </div>
    );
  }

  const stage = stageFor(project.status);

  // Each stage wraps the existing sub-view; transition callbacks re-fetch
  // (reload) so the dispatcher moves to the next stage. Logic inside the
  // sub-views is untouched.
  const inner = (() => {
    switch (stage) {
      case 'generating':
        return (
          <GeneratingScreen
            projectId={project.id}
            onReady={(p) => setProject(p)}
            onError={(message) => setProject({ ...project, status: 'failed', prompt: message })}
            onCancelled={() => navigate('/')}
          />
        );
      case 'preview':
        return (
          <PreviewScreen
            project={project}
            onCancelled={() => navigate('/')}
            onContinued={() => {
              refreshBalance();
              reload();
            }}
            onRetried={() => {
              refreshBalance();
              reload();
            }}
          />
        );
      case 'composing':
        return (
          <ComposerScreen
            project={project}
            onContinued={() => {
              refreshBalance();
              reload();
            }}
            onBack={reload}
          />
        );
      case 'animating':
        return (
          <AnimatingScreen
            projectId={project.id}
            onReady={(p) => setProject(p)}
            onError={(message) => setProject({ ...project, status: 'failed', prompt: message })}
            onCancelled={() => navigate('/')}
          />
        );
      case 'editor':
        return (
          <EditorScreen
            project={project}
            onExported={() => {
              refreshBalance();
              reload();
            }}
            onBack={reload}
          />
        );
      case 'done': {
        const render = project.render;
        const outputUrl = render?.outputUrl ?? null;
        const renderFailed = render?.status === 'failed';
        // The render output is served SAME-ORIGIN (/files) so the <video> plays
        // inline in Brave (Gotchas #13) and the download isn't a third-party hit.
        return (
          <div className="page">
            <div
              className="card"
              style={{ maxWidth: '640px', alignItems: 'center', textAlign: 'center' }}
            >
              {renderFailed ? (
                <>
                  <h1 className="card-title">Export failed</h1>
                  <p className="card-subtitle">
                    The final render didn't complete. Re-open the editor to export again.
                  </p>
                  <div className="banner banner-error" style={{ fontSize: '0.85rem' }}>
                    Your clips are safe — only the final stitch failed.
                  </div>
                  <div className="btn-row" style={{ justifyContent: 'center' }}>
                    <ReEditButton projectId={project.id} onReopened={reload} />
                    <Button variant="ghost" onClick={() => navigate('/')}>
                      Back to gallery
                    </Button>
                  </div>
                </>
              ) : outputUrl ? (
                <>
                  <h1 className="card-title">Your video is ready</h1>
                  <p className="card-subtitle">
                    Preview your final cut, then download or share it.
                  </p>
                  {/* biome-ignore lint/a11y/useMediaCaption: user-generated export has no caption track */}
                  <video
                    src={outputUrl}
                    // First frame as a poster while the video metadata loads.
                    poster={project.frames?.find((f) => f.signedUrl)?.signedUrl ?? undefined}
                    controls
                    playsInline
                    preload="metadata"
                    style={{
                      width: '100%',
                      borderRadius: 'var(--radius, 8px)',
                      background: '#000',
                      aspectRatio: '16 / 9',
                    }}
                  />
                  <div className="btn-row" style={{ justifyContent: 'center' }}>
                    <a
                      href={outputUrl}
                      download="coji-export.mp4"
                      className="btn btn-primary"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ↓ Download mp4
                    </a>
                    <ShareButton title="My coji video" />
                  </div>
                  <div className="btn-row" style={{ justifyContent: 'center' }}>
                    <ReEditButton projectId={project.id} onReopened={reload} />
                    <Button variant="ghost" onClick={() => navigate('/new')}>
                      Create another
                    </Button>
                  </div>
                  <CostBreakdown total={project.creditsSpent} rendered={true} />
                </>
              ) : (
                <>
                  <h1 className="card-title">Finalizing your video…</h1>
                  <p className="card-subtitle">
                    The render is wrapping up. This page will show the preview once it's ready.
                  </p>
                  <span
                    className="spinner"
                    style={{ fontSize: '1.5rem', color: 'var(--color-accent)' }}
                  />
                  <Button variant="ghost" onClick={reload}>
                    Refresh
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      }
      default:
        return (
          <div className="page">
            <div className="card">
              <h1 className="card-title">Something went wrong</h1>
              <div className="banner banner-error">
                {project.status === 'cancelled'
                  ? 'This project was cancelled.'
                  : `Project ended in an unexpected state (${project.status}).`}
              </div>
              <Button
                variant="ghost"
                onClick={() => navigate('/new')}
                style={{ alignSelf: 'flex-start' }}
              >
                Start over
              </Button>
            </div>
          </div>
        );
    }
  })();

  // Floating back link above the stage content (the page-centered sub-views
  // don't reserve a header slot, so we overlay it).
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1rem 1.5rem 0' }}>
        <BackLink />
      </div>
      {inner}
    </div>
  );
}
