/**
 * App — route tree for the Coji UI (react-router).
 *
 * Routes:
 *   /          → GalleryScreen (list owned projects)
 *   /new       → PromptScreen (create + start image generation)
 *   /p/:id     → ProjectScreen (status dispatcher over stage sub-views)
 *   /billing   → BillingScreen
 *   *          → redirect to /
 *
 * Auth gate: SessionProvider wraps the tree. While the session rehydrates we
 * render nothing (avoids flash). With no session we render SignInScreen for
 * ANY route — so a direct deep-link to /p/:id shows sign-in, never a blank
 * screen. The persistent AppHeader sits above the routed outlet once signed in.
 */

import { useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AppHeader } from './AppHeader.tsx';
import { BillingScreen } from './BillingScreen.tsx';
import { GalleryScreen } from './GalleryScreen.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { PromptScreen } from './PromptScreen.tsx';
import { SignInScreen } from './SignInScreen.tsx';
import { SessionProvider, useSession } from './session.tsx';

function NewProjectRoute({ refreshBalance }: { refreshBalance: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="content" style={{ maxWidth: '720px' }}>
      <PromptScreen
        onStarted={(projectId) => {
          refreshBalance();
          navigate(`/p/${projectId}`);
        }}
      />
    </div>
  );
}

function BillingRoute() {
  const navigate = useNavigate();
  return <BillingScreen onBack={() => navigate('/')} />;
}

function AppInner() {
  const { session, loading } = useSession();
  // Bumped after credit-spending actions to refresh the header balance.
  const [balanceKey, setBalanceKey] = useState(0);
  const refreshBalance = () => setBalanceKey((k) => k + 1);

  // While rehydrating session from localStorage, render nothing to avoid flash
  if (loading) return null;

  // Auth gate — any route without a session shows sign-in (deep-link safe)
  if (!session) return <SignInScreen />;

  return (
    <>
      <AppHeader refreshKey={balanceKey} />
      <Routes>
        <Route path="/" element={<GalleryScreen />} />
        <Route path="/new" element={<NewProjectRoute refreshBalance={refreshBalance} />} />
        <Route path="/p/:id" element={<ProjectScreen refreshBalance={refreshBalance} />} />
        <Route path="/billing" element={<BillingRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

export function App() {
  return (
    <SessionProvider>
      <AppInner />
    </SessionProvider>
  );
}
