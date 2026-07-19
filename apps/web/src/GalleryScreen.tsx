/**
 * GalleryScreen — landing route (`/`).
 *
 * Lists the caller's projects as a grid of cards (preview thumbnail of the
 * first frame or a status placeholder, prompt, status badge, date). Clicking
 * a card opens `/p/:id`; "Create new" goes to `/new`.
 *
 * States: loading (skeletons) → empty (EmptyState CTA) / error / list.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type ProjectListItem, listProjects } from './api.ts';
import { Button, EmptyState, Skeleton, StatusBadge, statusBadge } from './components/ui.tsx';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Emoji placeholder by status when no preview frame exists yet. */
function placeholderIcon(status: string): string {
  switch (statusBadge(status).tone) {
    case 'danger':
      return '⚠️';
    case 'success':
      return '🎬';
    case 'info':
      return '⏳';
    default:
      return '🖼️';
  }
}

/** Approximate dollar value of credits spent (5 cents per credit). */
const CREDIT_USD = 0.05;

function CostPill({ credits }: { credits: number }) {
  if (credits <= 0) return null;
  const usd = (credits * CREDIT_USD).toFixed(2);
  return (
    <span className="cost-pill" title={`${credits} credits ≈ $${usd}`}>
      {credits} cr · ~${usd}
    </span>
  );
}

function GalleryCard({ project }: { project: ProjectListItem }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="gallery-card"
      data-testid="gallery-card"
      data-project-id={project.id}
      onClick={() => navigate(`/p/${project.id}`)}
    >
      <div className="gallery-card__thumb">
        {project.previewUrl ? (
          <img src={project.previewUrl} alt={project.prompt} loading="lazy" />
        ) : (
          <span className="gallery-card__placeholder">{placeholderIcon(project.status)}</span>
        )}
      </div>
      <div className="gallery-card__body">
        <div className="gallery-card__prompt">{project.prompt || 'Untitled project'}</div>
        <div className="gallery-card__meta">
          <StatusBadge status={project.status} />
          <span className="gallery-card__date">{formatDate(project.createdAt)}</span>
        </div>
        <CostPill credits={project.creditsSpent} />
      </div>
    </button>
  );
}

function GallerySkeleton() {
  return (
    <div className="gallery-card" aria-hidden>
      <Skeleton style={{ aspectRatio: '16 / 10', borderRadius: 0 }} />
      <div className="gallery-card__body">
        <Skeleton style={{ height: '1em', width: '90%' }} />
        <Skeleton style={{ height: '1em', width: '60%' }} />
      </div>
    </div>
  );
}

export function GalleryScreen() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load projects.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="content">
      <div className="content__header">
        <div>
          <h1 className="content__title">Your projects</h1>
          <p className="content__subtitle">Every video you've started, newest first.</p>
        </div>
        <Button variant="primary" data-testid="create-new" onClick={() => navigate('/new')}>
          + Create new
        </Button>
      </div>

      {error ? (
        <div className="banner banner-error" data-testid="gallery-error">
          {error}
        </div>
      ) : projects === null ? (
        <div className="gallery-grid">
          {[0, 1, 2, 3].map((i) => (
            <GallerySkeleton key={i} />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          testId="gallery-empty"
          icon="🎬"
          title="No projects yet"
          body="Describe a scene and Coji will generate frames, then animate them into a video."
          action={
            <Button variant="primary" data-testid="create-new" onClick={() => navigate('/new')}>
              Create your first video
            </Button>
          }
        />
      ) : (
        <div className="gallery-grid">
          {projects.map((p) => (
            <GalleryCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
