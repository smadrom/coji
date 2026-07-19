/**
 * SignInScreen — email + password sign-in / sign-up gate.
 *
 * Calls Better Auth endpoints via `useSession().signIn` / `.signUp` (task
 * #22). Until #22 lands the session module falls back to the dev token so
 * the form still works in local dev.
 */

import type React from 'react';
import { useState } from 'react';
import { useSession } from './session.tsx';

export function SignInScreen() {
  const { signIn, signUp } = useSession();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <form className="card" onSubmit={handleSubmit} style={{ maxWidth: '400px' }}>
        <div>
          <h1 className="card-title">{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
          <p className="card-subtitle">
            {mode === 'signin'
              ? 'Sign in to your Coji account to continue.'
              : 'Create a free Coji account to get started.'}
          </p>
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-sm)' }}>
          <input
            type="text"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            required
            autoComplete={mode === 'signin' ? 'email' : 'email'}
          />
          <input
            type="text"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={busy || !email || !password}>
          {busy ? (
            <>
              <span className="spinner" style={{ fontSize: '0.85rem' }} />
              {mode === 'signin' ? 'Signing in…' : 'Creating account…'}
            </>
          ) : mode === 'signin' ? (
            'Sign in'
          ) : (
            'Create account'
          )}
        </button>

        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
          }}
          disabled={busy}
        >
          {mode === 'signin'
            ? "Don't have an account? Sign up"
            : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
