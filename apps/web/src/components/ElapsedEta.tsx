/**
 * ElapsedEta — a small "we're working on it" progress affordance for the
 * generating/animating wait screens.
 *
 * Since the server stages don't stream a true percentage, we show an honest
 * *time-based* estimate: elapsed mm:ss, a bar that eases toward `expectedSeconds`
 * (capped below 100% so it never claims completion before the stage actually
 * finishes), and a rough "~N min left" hint that switches to a "taking longer
 * than usual" message once we pass the expected duration.
 *
 * Determinate callers (e.g. the image stage's real frames-ready count) can pass
 * `progress` (0–1) to drive the bar directly instead of the time estimate; the
 * elapsed clock still ticks.
 */

import { useEffect, useState } from 'react';

interface Props {
  /** Typical duration for this stage, in seconds — drives the time-based bar. */
  expectedSeconds: number;
  /** Optional real progress (0–1). When set, overrides the time-based bar. */
  progress?: number;
}

/** mm:ss elapsed readout. */
function fmtElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Coarse "~N min/sec left" hint from the remaining estimate. */
function fmtRemaining(remainingSeconds: number): string {
  if (remainingSeconds >= 90) return `~${Math.round(remainingSeconds / 60)} min left`;
  if (remainingSeconds >= 15) return `~${Math.ceil(remainingSeconds / 15) * 15} sec left`;
  return 'almost done…';
}

export function ElapsedEta({ expectedSeconds, progress }: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const overdue = elapsed >= expectedSeconds;
  // Time-based fill eases toward expected, capped at 95% so it never reads "done"
  // before the stage settles. A real `progress` value takes precedence.
  const timeFraction = Math.min(0.95, elapsed / Math.max(1, expectedSeconds));
  const fraction = progress != null ? Math.max(0, Math.min(1, progress)) : timeFraction;
  const remaining = Math.max(0, expectedSeconds - elapsed);

  return (
    <div className="eta" aria-live="polite">
      <div className="progress-bar">
        <div className="progress-bar__fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="eta__row">
        <span className="eta__elapsed">Elapsed {fmtElapsed(elapsed)}</span>
        <span className="eta__remaining">
          {progress != null
            ? `${Math.round(fraction * 100)}%`
            : overdue
              ? 'Taking longer than usual…'
              : fmtRemaining(remaining)}
        </span>
      </div>
    </div>
  );
}
