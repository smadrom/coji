/**
 * AppHeader — persistent top NavBar shown when a session is active.
 *
 * Brand logo links to the gallery (`/`). Shows the live credit balance (a
 * link to `/billing`), a "New" shortcut, the user email, and sign-out.
 *
 * Balance is re-fetched whenever `refreshKey` changes so screens can trigger
 * a refresh after a credit-spending stage. `refreshKey` is a trigger value,
 * not a true React dependency — read via the effect dep array intentionally.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getBillingBalance } from './billing.ts';
import { Button } from './components/ui.tsx';
import { useSession } from './session.tsx';

interface Props {
  refreshKey?: number;
}

export function AppHeader({ refreshKey = 0 }: Props) {
  const { session, signOut } = useSession();
  const navigate = useNavigate();
  const [credits, setCredits] = useState<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional trigger prop; incrementing it re-fetches the balance
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    getBillingBalance()
      .then((b) => {
        if (!cancelled) setCredits(b.credits);
      })
      .catch(() => {
        if (!cancelled) setCredits(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session, refreshKey]);

  if (!session) return null;

  return (
    <header className="navbar">
      <Link to="/" className="navbar__brand" data-testid="gallery-link">
        <span className="navbar__brand-dot" />
        coji
      </Link>

      <div className="navbar__actions">
        <Button
          variant="ghost"
          onClick={() => navigate('/new')}
          data-testid="nav-new"
          style={{ fontSize: 'var(--fs-sm)', padding: '0.4rem 0.85rem' }}
        >
          + New
        </Button>

        <Link
          to="/billing"
          className="btn btn-ghost"
          data-testid="nav-billing"
          title="Buy credits"
          style={{ fontSize: 'var(--fs-sm)', padding: '0.4rem 0.85rem', textDecoration: 'none' }}
        >
          {credits !== null ? (
            <>
              <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{credits}</span>{' '}
              credits
            </>
          ) : (
            <span className="spinner" style={{ fontSize: '0.75rem' }} />
          )}
        </Link>

        <span className="navbar__email">{session.email}</span>

        <Button
          variant="ghost"
          onClick={signOut}
          style={{ fontSize: 'var(--fs-sm)', padding: '0.4rem 0.75rem' }}
        >
          Sign out
        </Button>

        <span
          className="navbar__version"
          title="App version"
          data-testid="app-version"
          style={{ fontSize: 'var(--fs-xs, 0.7rem)', opacity: 0.5, marginLeft: '0.25rem' }}
        >
          v{__APP_VERSION__}
        </span>
      </div>
    </header>
  );
}
