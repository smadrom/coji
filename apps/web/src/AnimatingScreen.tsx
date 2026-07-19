/**
 * AnimatingScreen — polls GET /projects/:id every 2 s until status transitions
 * out of the animating states and into 'clips_ready' (or fails/cancels).
 *
 * Shown after the user clicks "Continue" on the PreviewScreen. The animation
 * stage runs on the server (HeyGen jobs via task #18); this screen is a
 * waiting room that advances to the EditorScreen once all clips are ready.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, cancelProject, getProject } from './api.ts';
import type { ProjectDetailWithFrames } from './api.ts';
import { ElapsedEta } from './components/ElapsedEta.tsx';

interface Props {
  projectId: string;
  onReady: (project: ProjectDetailWithFrames) => void;
  onError: (message: string) => void;
  /** User cancelled the in-flight animation (returns to gallery). */
  onCancelled: () => void;
}

const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 200; // 10 min at 3 s

/** Typical animation-stage duration (HeyGen ~2–5 min); drives the ETA bar. */
const EXPECTED_ANIMATE_SECONDS = 3 * 60;

/** Statuses that mean "still working — keep polling". */
const PENDING_STATUSES = new Set(['awaiting_decision', 'animating']);

export function AnimatingScreen({ projectId, onReady, onError, onCancelled }: Props) {
  const [statusLabel, setStatusLabel] = useState('Animating clips…');
  const [cancelling, setCancelling] = useState(false);
  const pollCount = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCancel = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    // Stop polling so a late onReady/onError can't fire after we navigate away.
    if (timerRef.current) clearTimeout(timerRef.current);
    pollCount.current = MAX_POLLS; // guard any in-flight poll from rescheduling
    try {
      await cancelProject(projectId);
    } catch {
      // Best-effort: even if the cancel call fails (already settled/transient),
      // leave the waiting room — the gallery shows the true status on reload.
    }
    onCancelled();
  }, [cancelling, projectId, onCancelled]);

  const poll = useCallback(async () => {
    if (pollCount.current >= MAX_POLLS) {
      onError('Animation timed out. Please try again.');
      return;
    }
    pollCount.current++;

    try {
      const project = await getProject(projectId);

      if (project.status === 'clips_ready') {
        onReady(project);
        return;
      }

      if (project.status === 'failed') {
        onError('Animation failed. Please retry.');
        return;
      }

      if (project.status === 'cancelled') {
        onError('Project was cancelled.');
        return;
      }

      if (PENDING_STATUSES.has(project.status)) {
        setStatusLabel(`Animating clips… (${project.status})`);
      } else {
        // Unexpected status — keep polling but label it
        setStatusLabel(`Working… (${project.status})`);
      }

      timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (err) {
      if (err instanceof ApiError && (err.isUnauthorized || err.isNotFound)) {
        onError(err.message);
        return;
      }
      // Transient error — keep polling with longer backoff
      timerRef.current = setTimeout(poll, POLL_INTERVAL_MS * 2);
    }
  }, [projectId, onReady, onError]);

  useEffect(() => {
    poll();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll]);

  return (
    <div className="page">
      <div className="card" style={{ maxWidth: '480px', alignItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 className="card-title">Animating your clips</h1>
          <p className="card-subtitle">
            HeyGen is generating animation clips for each frame. This typically takes 2–5 minutes.
          </p>
        </div>

        <span className="spinner" style={{ fontSize: '2rem', color: 'var(--color-accent)' }} />

        <ElapsedEta expectedSeconds={EXPECTED_ANIMATE_SECONDS} />

        <div className="banner banner-info" style={{ fontSize: '0.85rem', textAlign: 'center' }}>
          {statusLabel}
        </div>

        <button
          type="button"
          className="btn btn-danger"
          onClick={handleCancel}
          disabled={cancelling}
        >
          {cancelling ? (
            <>
              <span className="spinner" style={{ fontSize: '0.8rem' }} /> Cancelling…
            </>
          ) : (
            'Cancel'
          )}
        </button>
      </div>
    </div>
  );
}
