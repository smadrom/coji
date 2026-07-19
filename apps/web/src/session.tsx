/**
 * Session context — bearer token lifecycle for Coji web.
 *
 * Wraps Better Auth (`/api/auth/sign-in/email`, `/api/auth/sign-up/email`,
 * `/api/auth/sign-out`). Until task #22 lands the sign-in call returns a
 * synthetic dev token so the rest of the app keeps working unchanged.
 *
 * Token is stored in localStorage under `coji_token`. authHeaders() in
 * api.ts reads from here when available; falls back to VITE_DEV_TOKEN in
 * pure-dev mode (no session).
 *
 * The x-user-id stub header is preserved alongside Authorization so the
 * current API stub still works while #22 is pending.
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { BASE_URL } from './api.ts';

export const SESSION_KEY = 'coji_token';
// x-user-id stub used until #22 lands (routes currently require this header)
export const SESSION_USER_KEY = 'coji_user_id';

export interface Session {
  token: string;
  userId: string;
  email: string;
}

interface SessionContextValue {
  session: Session | null;
  /** true while the initial localStorage check is running */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function persistSession(s: Session) {
  localStorage.setItem(SESSION_KEY, s.token);
  localStorage.setItem(SESSION_USER_KEY, s.userId);
  localStorage.setItem('coji_email', s.email);
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_USER_KEY);
  localStorage.removeItem('coji_email');
}

async function callAuth(path: string, body: Record<string, string>): Promise<Session> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(b.message ?? b.error ?? `Auth failed (${res.status})`);
  }
  const data = (await res.json()) as { token?: string; user?: { id: string; email: string } };
  if (!data.token || !data.user) throw new Error('Unexpected auth response');
  return { token: data.token, userId: data.user.id, email: data.user.email };
}

function devSession(email: string): Session | null {
  const devToken = (import.meta as { env?: { VITE_DEV_TOKEN?: string } }).env?.VITE_DEV_TOKEN ?? '';
  if (!devToken) return null;
  return { token: devToken, userId: email.split('@')[0] ?? 'dev', email };
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Stable ref so signIn/signUp callbacks don't need setSession in their dep array
  const setSessionRef = useRef(setSession);
  setSessionRef.current = setSession;

  // Rehydrate from localStorage on mount
  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    const userId = localStorage.getItem(SESSION_USER_KEY);
    const email = localStorage.getItem('coji_email') ?? '';
    if (token && userId) setSessionRef.current({ token, userId, email });
    setLoading(false);
  }, []);

  async function signIn(email: string, password: string) {
    let sess: Session;
    try {
      sess = await callAuth('/api/auth/sign-in/email', { email, password });
    } catch (err) {
      const fallback = devSession(email);
      if (!fallback) throw err;
      sess = fallback;
    }
    persistSession(sess);
    setSessionRef.current(sess);
  }

  async function signUp(email: string, password: string) {
    let sess: Session;
    try {
      sess = await callAuth('/api/auth/sign-up/email', {
        email,
        password,
        name: email.split('@')[0] ?? email,
      });
    } catch (err) {
      const fallback = devSession(email);
      if (!fallback) throw err;
      sess = fallback;
    }
    persistSession(sess);
    setSessionRef.current(sess);
  }

  function signOut() {
    clearSession();
    setSessionRef.current(null);
    // Best-effort: tell server to invalidate the session (#22)
    fetch(`${BASE_URL}/api/auth/sign-out`, { method: 'POST' }).catch(() => null);
  }

  return (
    <SessionContext.Provider value={{ session, loading, signIn, signUp, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
