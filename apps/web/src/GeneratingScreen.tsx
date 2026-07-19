/**
 * GeneratingScreen — polls GET /projects/:id every 2 s until status=images_ready,
 * showing per-frame progress as frames[].status comes in from #14.
 *
 * Shows a 4-slot frame grid; each slot updates individually as the runner
 * delivers frames. Once all 4 are ready (status=images_ready) calls onReady().
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FrameRow, ProjectDetailWithFrames } from './api.ts';
import { ApiError, cancelProject, getProject } from './api.ts';
import { ElapsedEta } from './components/ElapsedEta.tsx';

interface Props {
  projectId: string;
  onReady: (project: ProjectDetailWithFrames) => void;
  onError: (message: string) => void;
  /** User cancelled image generation (returns to gallery). */
  onCancelled: () => void;
}

const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 300; // 10 min timeout

/** Frames are generated sequentially; ~30–90 s total drives the ETA bar. */
const EXPECTED_IMAGE_SECONDS = 75;

const TERMINAL_STATUSES = new Set(['images_ready', 'cancelled', 'failed']);

function frameStatusLabel(status: FrameRow['status']): string {
  switch (status) {
    case 'pending':
      return 'Waiting…';
    case 'generating':
      return 'Generating…';
    case 'ready':
      return 'Ready';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

function FrameSlot({ frame, idx }: { frame?: FrameRow; idx: number }) {
  const ready = frame?.status === 'ready';
  const generating = frame?.status === 'generating';
  const failed = frame?.status === 'failed';

  return (
    <div className="frame-card">
      <div className="frame-card__img-wrap">
        {ready && frame?.signedUrl ? (
          <img
            src={frame.signedUrl}
            alt={`Frame ${idx + 1}`}
            loading="lazy"
            data-testid="frame-thumb"
          />
        ) : (
          <div className="frame-card__status">
            {generating ? (
              <span className="spinner" style={{ color: 'var(--color-accent)' }} />
            ) : failed ? (
              <span style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>Failed</span>
            ) : (
              <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
                Frame {idx + 1}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="frame-card__caption">
        {ready && frame?.caption ? frame.caption : frameStatusLabel(frame?.status ?? 'pending')}
      </div>
    </div>
  );
}

export function GeneratingScreen({ projectId, onReady, onError, onCancelled }: Props) {
  const [frames, setFrames] = useState<(FrameRow | undefined)[]>([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  const [projectStatus, setProjectStatus] = useState<string>('draft');
  const [cancelling, setCancelling] = useState(false);
  const pollCount = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readyCount = frames.filter((f) => f?.status === 'ready').length;

  const handleCancel = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    // Stop polling so a late onReady/onError can't fire after we navigate away.
    if (timerRef.current) clearTimeout(timerRef.current);
    pollCount.current = MAX_POLLS; // guard any in-flight poll from rescheduling
    try {
      await cancelProject(projectId);
    } catch {
      // Best-effort: leave the waiting room regardless; the gallery reflects
      // the true status on reload.
    }
    onCancelled();
  }, [cancelling, projectId, onCancelled]);

  const poll = useCallback(async () => {
    if (pollCount.current >= MAX_POLLS) {
      onError('Image generation timed out. Please try again.');
      return;
    }
    pollCount.current++;

    try {
      const project = await getProject(projectId);
      setProjectStatus(project.status);

      if (project.frames && project.frames.length > 0) {
        const slots: (FrameRow | undefined)[] = [undefined, undefined, undefined, undefined];
        for (const f of project.frames) {
          if (f.idx >= 0 && f.idx < 4) slots[f.idx] = f;
        }
        setFrames(slots);
      }

      if (project.status === 'images_ready') {
        onReady(project);
        return;
      }

      if (project.status === 'failed') {
        onError('Image generation failed. Please retry with a different prompt.');
        return;
      }

      if (project.status === 'cancelled') {
        onError('Project was cancelled.');
        return;
      }

      // Continue polling
      timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.isUnauthorized) {
          onError('Authentication required.');
          return;
        }
        if (err.isNotFound) {
          onError('Project not found.');
          return;
        }
      }
      // Transient network error — keep polling
      timerRef.current = setTimeout(poll, POLL_INTERVAL_MS * 2);
    }
  }, [projectId, onReady, onError]);

  useEffect(() => {
    poll();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll]);

  const statusLabel =
    projectStatus === 'images_ready' ? 'All frames ready!' : `Generating frames… (${readyCount}/4)`;

  return (
    <div className="page">
      <div className="card">
        <div>
          <h1 className="card-title">Generating frames</h1>
          <p className="card-subtitle">{statusLabel}</p>
        </div>

        <ElapsedEta expectedSeconds={EXPECTED_IMAGE_SECONDS} progress={readyCount / 4} />

        <div className="frame-grid">
          {([0, 1, 2, 3] as const).map((idx) => (
            <FrameSlot key={idx} frame={frames[idx]} idx={idx} />
          ))}
        </div>

        <div className="banner banner-info" style={{ fontSize: '0.85rem' }}>
          <span className="spinner" style={{ fontSize: '0.75rem', marginRight: '0.5rem' }} />
          Frames are generated sequentially to ensure character consistency. This takes 30–90
          seconds.
        </div>

        <button
          type="button"
          className="btn btn-danger"
          onClick={handleCancel}
          disabled={cancelling}
          style={{ alignSelf: 'flex-start' }}
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
