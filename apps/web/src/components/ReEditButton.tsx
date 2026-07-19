/**
 * ReEditButton — reopen a rendered project for editing.
 *
 * Calls POST /projects/:id/reopen (rendered → editing). On success the caller
 * reloads, and the project dispatcher re-routes to the editor where the user can
 * re-trim/reorder and re-export (a fresh render runs via the render_attempt
 * bump). Degrades with an explicit message if the reopen route isn't available
 * yet (404/501) — never a silent dead-end.
 */

import { useState } from 'react';
import { ApiError, reopenProject } from '../api.ts';

interface Props {
  projectId: string;
  /** Called after a successful reopen so the parent can reload + re-route. */
  onReopened: () => void;
}

export function ReEditButton({ projectId, onReopened }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await reopenProject(projectId);
      onReopened();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && (err.status === 404 || err.status === 501)) {
        setError('Re-editing isn’t available yet — create a new video for now.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not reopen the editor.');
      }
    }
  }

  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={handleClick} disabled={busy}>
        {busy ? (
          <>
            <span className="spinner" style={{ fontSize: '0.8rem' }} /> Reopening…
          </>
        ) : (
          '✎ Re-edit'
        )}
      </button>
      {error && (
        <div className="banner banner-error" style={{ fontSize: '0.8rem' }}>
          {error}
        </div>
      )}
    </>
  );
}
