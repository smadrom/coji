/**
 * EditorScreen — an NLE-style timeline video editor built on the Remotion <Player>.
 *
 *   - Remotion Player preview (CojiEditorComposition: a Series of <Video> clips).
 *   - A real timeline: a two-tier time ruler + a clip track where each clip is a
 *     block sized to its real duration, laid end-to-end. A draggable playhead is
 *     synced to the Player; clicking/dragging the track seeks. Each clip block has
 *     trim handles (drag the edges) that set the in/out points fed to Remotion.
 *   - Transport: play/pause, skip-to-clip, frame nudge + mm:ss.cs / total.
 *   - Export → POST /projects/:id/export → poll until rendered → download.
 *
 * Real per-clip durations come from the server (`clip.durationInFrames`) when
 * present; otherwise they are probed client-side from each clip's <video>
 * metadata via a hidden <video> kept mounted in JSX (so the browser doesn't GC
 * it before `loadedmetadata` fires).
 */

import { VIDEO_HEIGHT, VIDEO_WIDTH } from '@coji/shared/video';
import { Player, type PlayerRef } from '@remotion/player';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  exportProject,
  getProject,
  getRenderEstimate,
  reanimateClip,
  saveTrims,
} from './api.ts';
import type { ClipRow, ProjectDetailWithFrames, SaveTrim } from './api.ts';
import { CojiEditorComposition, type EditorClipProps } from './editor-composition.tsx';
import { detectSpeechBoundsFromSamples } from './lib/autoTrim.ts';

interface Props {
  project: ProjectDetailWithFrames;
  onExported: (outputUrl: string) => void;
  onBack: () => void;
}

const FPS = 30;
// Vertical 9:16 (TikTok/Reels) — single source in @coji/shared, matches export.
const WIDTH = VIDEO_WIDTH;
const HEIGHT = VIDEO_HEIGHT;
const FALLBACK_FRAMES = 60; // until a clip's real duration is probed (~2s)
const EXPORT_POLL_INTERVAL_MS = 3_000;
const EXPORT_MAX_POLLS = 200;

/** In/out trim per clip, in frames within that clip. */
interface Trim {
  start: number;
  end: number; // exclusive; clamp to the clip's full frame count
}

/** A completed clip that is actually playable/renderable (videoUrl present). */
type PlayableClip = ClipRow & { videoUrl: string };

/** mm:ss.cs — centisecond precision, the NLE-standard readout. */
function fmtTime(frames: number): string {
  const s = Math.max(0, frames) / FPS;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${m}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Compact label for ruler ticks (no leading minute when under a minute). */
function fmtTick(frames: number): string {
  const s = Math.round(frames / FPS);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Pick a ruler step (in seconds) so we never draw more than ~14 major ticks. */
function rulerStepSeconds(totalSeconds: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const step of steps) {
    if (totalSeconds / step <= 14) return step;
  }
  return steps[steps.length - 1]!;
}

const CLIP_COLORS = ['#7c6ff7', '#46c78a', '#f0a830', '#e0605f', '#5aa9f0', '#c071f0'];

/**
 * Rebuild a full order array (visible + removed clip ids) from a reordered
 * sequence of the VISIBLE ids. Removed ids are kept (appended, preserving their
 * prior relative order) so a deletion is never lost and the arrangement stays
 * lossless. Pure — easy to reason about and unit-test.
 */
function mergeVisibleOrder(
  fullOrder: string[],
  newVisible: string[],
  removed: Set<string>,
): string[] {
  const removedInOrder = fullOrder.filter((id) => removed.has(id));
  return [...newVisible, ...removedInOrder];
}

// Debounce window for persisting trim edits to the server.
const TRIM_SAVE_DEBOUNCE_MS = 800;

/**
 * Detect where speech starts/ends in a clip by decoding its audio track and
 * delegating to the pure RMS scanner in lib/autoTrim.ts. Returns the in/out
 * points in FRAMES, or null when the clip is silent / can't be analysed (→ keep
 * full). The fetch + decode are browser-only; the scan itself is unit-tested.
 *
 * Same-origin `/files` clip URLs are required for `decodeAudioData` to read the
 * bytes cross-context — which is exactly what the editor now serves.
 */
async function detectSpeechBounds(
  url: string,
): Promise<{ startFrame: number; endFrame: number } | null> {
  const Ctx: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  let ctx: AudioContext | null = null;
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    ctx = new Ctx();
    const audio = await ctx.decodeAudioData(buf);
    return detectSpeechBoundsFromSamples(audio.getChannelData(0), audio.sampleRate, FPS);
  } catch {
    return null;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

export function EditorScreen({ project, onExported, onBack }: Props) {
  const allClips = useMemo<ClipRow[]>(() => project.clips ?? [], [project.clips]);
  // Only COMPLETED clips are playable / renderable; they drive the timeline,
  // composition, trims and export. A clip with no status is a legacy completed
  // clip (the view widened to include failed clips as of C2). Non-completed
  // clips (failed/animating/pending) are surfaced separately below so they're
  // never silently dropped.
  // Playable clips must be completed AND carry a video URL. (The widened view
  // returns videoUrl:null for non-completed clips — those are surfaced as a
  // failure/in-progress notice, never played or rendered.)
  const clips = useMemo<PlayableClip[]>(
    () => allClips.filter((c): c is PlayableClip => c.status === 'completed' && c.videoUrl != null),
    [allClips],
  );
  const failedClips = useMemo<ClipRow[]>(
    () => allClips.filter((c) => c.status === 'failed'),
    [allClips],
  );
  const pendingClips = useMemo<ClipRow[]>(
    () => allClips.filter((c) => c.status === 'animating' || c.status === 'pending'),
    [allClips],
  );

  // Real per-clip length in frames. Seeded from the server's
  // `clip.durationInFrames` when present, else probed from <video> metadata.
  const [fullFrames, setFullFrames] = useState<Record<string, number>>({});
  // In/out trim per clip id.
  const [trims, setTrims] = useState<Record<string, Trim>>({});
  const [frame, setFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selected, setSelected] = useState(0);
  // Editor arrangement: explicit render order (clip ids) + deleted clip ids.
  // Both are seeded from the playable clips in their natural (idx) order and
  // drive the timeline, the Remotion preview, and the export payload.
  const [order, setOrder] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());

  const [exportState, setExportState] = useState<
    'idle' | 'exporting' | 'polling' | 'done' | 'error'
  >('idle');
  const [exportError, setExportError] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  // Export credit cost shown before the user commits — null until fetched (and
  // stays null if the estimate endpoint isn't deployed yet → button hides it).
  const [exportCredits, setExportCredits] = useState<number | null>(null);
  // Clip id currently being re-animated (disables its button + shows progress).
  const [reanimatingId, setReanimatingId] = useState<string | null>(null);
  const [reanimateError, setReanimateError] = useState<string | null>(null);

  // Fetch the export/render credit cost so it's shown on the button. Degrades
  // gracefully: a missing endpoint (404) just leaves the cost hidden.
  useEffect(() => {
    let cancelled = false;
    getRenderEstimate(project.id)
      .then((est) => {
        if (!cancelled) setExportCredits(est.credits);
      })
      .catch(() => {
        if (!cancelled) setExportCredits(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const playerRef = useRef<PlayerRef>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Clip id currently being dragged for reorder (HTML drag-and-drop).
  const dragIdRef = useRef<string | null>(null);
  const exportPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportPollCount = useRef(0);

  // Prefer the server-provided duration; fall back to the client probe.
  // Runs whenever the clip list (or its server durations) changes.
  useEffect(() => {
    setFullFrames((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const clip of clips) {
        const server = clip.durationInFrames;
        if (server && server > 0 && !next[clip.id]) {
          next[clip.id] = Math.max(1, Math.round(server));
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [clips]);

  // Record a clip's probed duration (in frames). The mounted <video> probes
  // (below) call this; we keep them in the DOM so the browser doesn't GC them
  // before `loadedmetadata` fires. No-op once a duration is already known.
  const recordDuration = useCallback((clipId: string, seconds: number) => {
    const f = Math.max(1, Math.round((seconds || FALLBACK_FRAMES / FPS) * FPS));
    setFullFrames((prev) => (prev[clipId] ? prev : { ...prev, [clipId]: f }));
  }, []);

  // Initialise a clip's trim once its duration is known. Prefer the PERSISTED
  // trim (clip.trimStartFrame/trimEndFrame from the server) so a reload restores
  // the user's edits; fall back to the clip's full length when none is stored.
  useEffect(() => {
    setTrims((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const clip of clips) {
        const full = fullFrames[clip.id];
        if (!full || next[clip.id]) continue;
        const ps = clip.trimStartFrame;
        const pe = clip.trimEndFrame;
        if (ps != null && pe != null) {
          // Clamp persisted values to the known duration (defensive).
          const start = Math.max(0, Math.min(ps, full - 1));
          const end = Math.max(start + 1, Math.min(pe, full));
          next[clip.id] = { start, end };
        } else {
          next[clip.id] = { start: 0, end: full };
        }
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [clips, fullFrames]);

  const [analyzing, setAnalyzing] = useState(false);
  const autoTrimmedRef = useRef(false);

  // ---- Trim persistence (debounced) ----
  // Signature of the last set of trims we've saved (or hydrated from the
  // server). The debounced save below only fires when the current trims differ,
  // so loading persisted trims never triggers a redundant write.
  const lastSavedSigRef = useRef<string | null>(null);
  const trimSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Mirror of `trims` for callbacks that need the latest value without being in
  // the dependency array (e.g. the post-auto-trim immediate persist).
  const trimsRef = useRef<Record<string, Trim>>({});
  // Undo history of trim snapshots (most recent last). Each user action that
  // changes trims (drag/auto-trim/reset/snap) pushes the PRE-change state.
  const historyRef = useRef<Record<string, Trim>[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  // Cached speech bounds (frames) per clip, from auto-trim — reused as snap
  // targets while dragging a trim handle.
  const speechBoundsRef = useRef<Record<string, { startFrame: number; endFrame: number }>>({});

  const pushHistory = useCallback((snapshot: Record<string, Trim>) => {
    historyRef.current.push(snapshot);
    if (historyRef.current.length > 50) historyRef.current.shift(); // cap memory
    setCanUndo(true);
  }, []);

  const undoTrims = useCallback(() => {
    const prev = historyRef.current.pop();
    setCanUndo(historyRef.current.length > 0);
    if (prev) setTrims(prev);
  }, []);

  const runAutoTrim = useCallback(async () => {
    setAnalyzing(true);
    // Snapshot so a manual auto-trim is a single undo step.
    pushHistory(trimsRef.current);
    try {
      const updates: Record<string, Trim> = {};
      for (const clip of clips) {
        const full = fullFrames[clip.id];
        if (!full) continue;
        const bounds = await detectSpeechBounds(clip.videoUrl);
        if (!bounds) continue;
        // Cache the speech bounds so trim handles can snap to them later.
        speechBoundsRef.current[clip.id] = bounds;
        const start = Math.max(0, Math.min(bounds.startFrame, full - 1));
        const end = Math.max(start + 1, Math.min(bounds.endFrame, full));
        // Skip no-op trims (already tight) to avoid churn.
        if (start > 0 || end < full) updates[clip.id] = { start, end };
      }
      if (Object.keys(updates).length > 0) {
        setTrims((prev) => ({ ...prev, ...updates }));
      }
    } finally {
      setAnalyzing(false);
    }
  }, [clips, fullFrames, pushHistory]);

  const resetTrims = useCallback(() => {
    pushHistory(trimsRef.current);
    setTrims(() => {
      const next: Record<string, Trim> = {};
      for (const clip of clips) {
        const full = fullFrames[clip.id];
        if (full) next[clip.id] = { start: 0, end: full };
      }
      return next;
    });
  }, [clips, fullFrames, pushHistory]);

  // Keep the ref in lock-step with the trims state for closure-free reads.
  useEffect(() => {
    trimsRef.current = trims;
  }, [trims]);

  // Build the persist payload (one entry per ready clip) + a stable signature
  // from a given trims map. Only clips whose duration is known are included so
  // we never persist a trim against a fallback length.
  const buildSavePayloadFrom = useCallback(
    (source: Record<string, Trim>): { payload: SaveTrim[]; sig: string } => {
      const payload: SaveTrim[] = [];
      for (const clip of clips) {
        const full = fullFrames[clip.id];
        if (!full) continue;
        const t = source[clip.id] ?? { start: 0, end: full };
        payload.push({ clipId: clip.id, startFrame: t.start, endFrame: t.end });
      }
      // Order-independent signature so reordering never causes a churn save.
      const sig = [...payload]
        .sort((a, b) => a.clipId.localeCompare(b.clipId))
        .map((p) => `${p.clipId}:${p.startFrame}:${p.endFrame}`)
        .join('|');
      return { payload, sig };
    },
    [clips, fullFrames],
  );

  const buildSavePayload = useCallback(
    () => buildSavePayloadFrom(trims),
    [buildSavePayloadFrom, trims],
  );

  // Persist the CURRENT trims immediately (bypassing the debounce), updating the
  // saved baseline + flipping the local auto-trimmed guard. Used right after the
  // one-shot auto-trim so the server flag flips even with no visible change.
  const persistTrimsNow = useCallback(async () => {
    const { payload, sig } = buildSavePayloadFrom(trimsRef.current);
    if (payload.length === 0) return;
    if (trimSaveTimerRef.current) clearTimeout(trimSaveTimerRef.current);
    setSaveState('saving');
    try {
      await saveTrims(project.id, payload);
      lastSavedSigRef.current = sig;
      autoTrimmedRef.current = true;
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [buildSavePayloadFrom, project.id]);

  // Flush any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (trimSaveTimerRef.current) clearTimeout(trimSaveTimerRef.current);
    };
  }, []);

  // Ctrl/Cmd+Z → undo the last trim change (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
        e.preventDefault();
        undoTrims();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoTrims]);

  // Keep `order` in sync with the playable clips: append any new clip ids (in
  // natural idx order) and drop ids that no longer exist. Existing order/removed
  // choices are preserved across reloads within a session.
  useEffect(() => {
    setOrder((prev) => {
      const ids = clips.map((c) => c.id);
      const idSet = new Set(ids);
      const kept = prev.filter((id) => idSet.has(id));
      const keptSet = new Set(kept);
      const appended = ids.filter((id) => !keptSet.has(id));
      const next = [...kept, ...appended];
      // Avoid a state churn when nothing changed.
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      return next;
    });
  }, [clips]);

  // The clips actually on the timeline: in render order, excluding deleted ones.
  const orderedClips = useMemo<PlayableClip[]>(() => {
    const byId = new Map(clips.map((c) => [c.id, c] as const));
    return order
      .filter((id) => !removed.has(id))
      .map((id) => byId.get(id))
      .filter((c): c is PlayableClip => c != null);
  }, [clips, order, removed]);

  // ---- Derived timeline model ----
  const segments = useMemo(
    () =>
      orderedClips.map((clip) => {
        const full = fullFrames[clip.id] ?? FALLBACK_FRAMES;
        const trim = trims[clip.id] ?? { start: 0, end: full };
        return { clip, full, trim, length: Math.max(1, trim.end - trim.start) };
      }),
    [orderedClips, fullFrames, trims],
  );

  const total = useMemo(() => segments.reduce((sum, s) => sum + s.length, 0), [segments]);

  // Frame offset where each segment begins on the global timeline.
  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const s of segments) {
      out.push(acc);
      acc += s.length;
    }
    return out;
  }, [segments]);

  const compositionClips = useMemo<EditorClipProps[]>(
    () =>
      segments.map((s) => ({
        videoUrl: s.clip.videoUrl,
        durationInFrames: s.length,
        startFrom: s.trim.start,
        endAt: s.trim.end,
      })),
    [segments],
  );

  // Probing is done once every ON-TIMELINE clip has a known duration. (When the
  // user has deleted every clip, `segments` is empty → handled as its own state.)
  const ready = clips.length > 0 && orderedClips.every((c) => fullFrames[c.id]);
  const allRemoved = clips.length > 0 && orderedClips.length === 0;

  // Debounced persist of trims. Seeds the saved-signature from the first fully
  // hydrated state (persisted or full-length) so loading never triggers a write;
  // thereafter, any change (drag/auto-trim/reset) is saved once it settles.
  useEffect(() => {
    if (!ready) return;
    const { payload, sig } = buildSavePayload();
    if (payload.length === 0) return;
    if (lastSavedSigRef.current === null) {
      // First hydration — adopt the current state as the baseline, no save.
      lastSavedSigRef.current = sig;
      return;
    }
    if (sig === lastSavedSigRef.current) return; // unchanged

    if (trimSaveTimerRef.current) clearTimeout(trimSaveTimerRef.current);
    trimSaveTimerRef.current = setTimeout(async () => {
      setSaveState('saving');
      try {
        await saveTrims(project.id, payload);
        lastSavedSigRef.current = sig;
        // The first successful save flips the server's auto_trimmed flag, so a
        // later reload won't re-run auto-trim.
        autoTrimmedRef.current = true;
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, TRIM_SAVE_DEBOUNCE_MS);
    // We intentionally depend on the signature via buildSavePayload (trims).
  }, [ready, buildSavePayload, project.id]);

  // ---- Reorder / delete ----
  // Move an on-timeline clip one slot left/right (keyboard + button a11y path).
  const moveClip = useCallback(
    (clipId: string, dir: -1 | 1) => {
      setOrder((prev) => {
        const visible = prev.filter((id) => !removed.has(id));
        const at = visible.indexOf(clipId);
        const to = at + dir;
        if (at < 0 || to < 0 || to >= visible.length) return prev;
        // Swap within the VISIBLE sequence, then splice back the removed ids in
        // their original relative positions so nothing is lost.
        const swapped = [...visible];
        [swapped[at], swapped[to]] = [swapped[to]!, swapped[at]!];
        return mergeVisibleOrder(prev, swapped, removed);
      });
    },
    [removed],
  );

  // Drop `clipId` so it lands at the position of `beforeClipId` (pointer drag).
  const reorderTo = useCallback(
    (clipId: string, beforeClipId: string) => {
      if (clipId === beforeClipId) return;
      setOrder((prev) => {
        const visible = prev.filter((id) => !removed.has(id));
        const from = visible.indexOf(clipId);
        const to = visible.indexOf(beforeClipId);
        if (from < 0 || to < 0) return prev;
        const next = [...visible];
        next.splice(from, 1);
        next.splice(to, 0, clipId);
        return mergeVisibleOrder(prev, next, removed);
      });
    },
    [removed],
  );

  const deleteClip = useCallback((clipId: string) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      next.add(clipId);
      return next;
    });
  }, []);

  const restoreAll = useCallback(() => setRemoved(new Set()), []);

  // Auto-trim to speech ONCE per project — and only if the server says this
  // project has never been auto-trimmed (project.autoTrimmed). This prevents
  // re-running over persisted/manual trims on every reload. The user can still
  // re-run on demand via the "Auto-trim" button. The first save flips the
  // server flag, so subsequent loads skip this.
  useEffect(() => {
    if (!ready || autoTrimmedRef.current) return;
    if (project.autoTrimmed) {
      autoTrimmedRef.current = true; // already auto-trimmed server-side → never auto-run
      return;
    }
    autoTrimmedRef.current = true;
    // Run the one-shot auto-trim, then persist unconditionally so the server's
    // auto_trimmed flag flips even when the scan changed nothing (e.g. clips
    // already tight / silent) — otherwise it would re-run on the next load.
    void runAutoTrim().then(() => persistTrimsNow());
  }, [ready, runAutoTrim, persistTrimsNow, project.autoTrimmed]);

  // ---- Player wiring ----
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach listeners once the Player mounts (gated on `ready`)
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    const onFrame = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);
    player.addEventListener('frameupdate', onFrame);
    return () => {
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
      player.removeEventListener('frameupdate', onFrame);
    };
  }, [ready]);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying) p.pause();
    else p.play();
  }, [isPlaying]);

  const seekToFrame = useCallback(
    (f: number) => {
      const clamped = Math.max(0, Math.min(Math.round(f), Math.max(0, total - 1)));
      playerRef.current?.seekTo(clamped);
      setFrame(clamped);
    },
    [total],
  );

  // Jump the playhead to the start of a given clip and select it.
  const seekToClip = useCallback(
    (i: number) => {
      const at = offsets[i];
      if (at == null) return;
      seekToFrame(at);
      setSelected(i);
    },
    [offsets, seekToFrame],
  );

  // Which segment the current global frame lands in (drives the highlight).
  useEffect(() => {
    if (segments.length === 0) return;
    let acc = 0;
    let idx = segments.length - 1; // default: last clip (covers frame === total)
    for (let i = 0; i < segments.length; i++) {
      acc += segments[i]?.length ?? 0;
      if (frame < acc) {
        idx = i;
        break;
      }
    }
    setSelected(idx);
  }, [frame, segments]);

  // ---- Timeline interactions ----
  const frameFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const frac = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(1, frac)) * total;
    },
    [total],
  );

  function handleTrackPointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('.tl-trim')) return; // trim handle owns it
    seekToFrame(frameFromClientX(e.clientX));
    const move = (ev: PointerEvent) => seekToFrame(frameFromClientX(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startTrimDrag(e: React.PointerEvent, clipId: string, edge: 'start' | 'end') {
    e.stopPropagation();
    e.preventDefault();
    const el = trackRef.current;
    if (!el) return;
    // Snapshot the pre-drag trims so the whole drag is a single undo step.
    pushHistory(trims);
    const full = fullFrames[clipId] ?? FALLBACK_FRAMES;
    const base = trims[clipId] ?? { start: 0, end: full };
    const startX = e.clientX;
    // Frames-per-pixel captured at drag start (stable for the whole drag).
    const framesPerPx = Math.max(1, total) / el.getBoundingClientRect().width;
    // Snap a dragged edge to the clip's detected speech boundary when it lands
    // within ~6px of it (reuses the auto-trim bounds; magnet feel).
    const snapThreshold = Math.max(2, Math.round(6 * framesPerPx));
    const snapTarget = speechBoundsRef.current[clipId];
    const move = (ev: PointerEvent) => {
      const deltaFrames = Math.round((ev.clientX - startX) * framesPerPx);
      setTrims((prev) => {
        const cur = prev[clipId] ?? base;
        if (edge === 'start') {
          // Relative delta from the captured base, clamped to [0, end-1].
          let start = Math.max(0, Math.min(base.start + deltaFrames, cur.end - 1));
          if (snapTarget && Math.abs(start - snapTarget.startFrame) <= snapThreshold) {
            start = Math.max(0, Math.min(snapTarget.startFrame, cur.end - 1));
          }
          return { ...prev, [clipId]: { ...cur, start } };
        }
        // Relative delta from the captured base, clamped to [start+1, full].
        let end = Math.max(cur.start + 1, Math.min(base.end + deltaFrames, full));
        if (snapTarget && Math.abs(end - snapTarget.endFrame) <= snapThreshold) {
          end = Math.max(cur.start + 1, Math.min(snapTarget.endFrame, full));
        }
        return { ...prev, [clipId]: { ...cur, end } };
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- Export ----
  const pollExport = useCallback(async () => {
    if (exportPollCount.current >= EXPORT_MAX_POLLS) {
      setExportState('error');
      setExportError('Export timed out. Please try again.');
      return;
    }
    exportPollCount.current++;
    try {
      const p = await getProject(project.id);
      if (p.status === 'rendered' && p.render?.outputUrl) {
        const url = p.render.outputUrl;
        setOutputUrl(url);
        setExportState('done');
        onExported(url);
        return;
      }
      if (p.status === 'failed' || p.render?.status === 'failed') {
        setExportState('error');
        setExportError('Export render failed. Please try again.');
        return;
      }
      exportPollRef.current = setTimeout(pollExport, EXPORT_POLL_INTERVAL_MS);
    } catch {
      exportPollRef.current = setTimeout(pollExport, EXPORT_POLL_INTERVAL_MS * 2);
    }
  }, [project.id, onExported]);

  async function handleExport() {
    if (exportState === 'exporting' || exportState === 'polling') return;
    setExportState('exporting');
    setExportError(null);
    exportPollCount.current = 0;
    try {
      // Send an explicit ORDERED clip selection so reorder/delete + trims all
      // transfer to the render (E1). Render order = array order; clips the user
      // deleted are simply absent.
      const clipSelection = segments.map((s) => ({
        clipId: s.clip.id,
        startFrom: s.trim.start,
        endAt: s.trim.end,
      }));
      await exportProject(project.id, { clips: clipSelection });
      setExportState('polling');
      exportPollRef.current = setTimeout(pollExport, EXPORT_POLL_INTERVAL_MS);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 501)) {
        setExportState('error');
        setExportError('Export is not available yet. Please check back soon.');
      } else {
        setExportState('error');
        setExportError(err instanceof ApiError ? err.message : 'Export failed. Please try again.');
      }
    }
  }

  useEffect(() => {
    return () => {
      if (exportPollRef.current) clearTimeout(exportPollRef.current);
    };
  }, []);

  // ---- Re-animate a single failed clip (C2) ----
  // The route moves the whole project back into `animating`, so once the job is
  // accepted we hand back to the dispatcher (onBack → reload) which re-routes to
  // the AnimatingScreen waiting room; it polls to clips_ready and returns here.
  async function handleReanimate(clipId: string) {
    if (reanimatingId) return;
    setReanimatingId(clipId);
    setReanimateError(null);
    try {
      await reanimateClip(project.id, clipId);
      onBack(); // reload → project is now 'animating' → AnimatingScreen
    } catch (err) {
      setReanimatingId(null);
      setReanimateError(
        err instanceof ApiError ? err.message : 'Could not start re-animation. Please try again.',
      );
    }
  }

  const exportBusy = exportState === 'exporting' || exportState === 'polling';
  const exportLabel =
    exportState === 'exporting'
      ? 'Starting export…'
      : exportState === 'polling'
        ? 'Rendering…'
        : exportCredits != null
          ? `Export video → ${exportCredits} credits`
          : 'Export video';

  // ---- Ruler ticks (adaptive density) ----
  const ticks = useMemo(() => {
    const totalSeconds = total / FPS;
    if (totalSeconds <= 0) return [] as { sec: number; major: boolean }[];
    const step = rulerStepSeconds(totalSeconds);
    // Minor ticks at step/2 when there's room, for a finer (but uncrowded) grid.
    const minor = step / 2;
    const out: { sec: number; major: boolean }[] = [];
    for (let s = 0; s <= totalSeconds + 0.001; s += minor) {
      const sec = Math.round(s * 100) / 100;
      out.push({ sec, major: Math.abs(sec % step) < 0.001 });
    }
    return out;
  }, [total]);

  const playheadPct = (frame / Math.max(1, total)) * 100;

  return (
    <div className="page editor-page">
      <div className="editor-header editor-toolbar">
        <button type="button" className="btn btn-ghost editor-back" onClick={onBack}>
          ← Back
        </button>
        <h1 className="card-title editor-title">Editor</h1>
        <div className="editor-toolbar__spacer" />
        {exportState === 'done' && outputUrl ? (
          <a
            href={outputUrl}
            download="coji-export.mp4"
            className="btn btn-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            ↓ Download mp4
          </a>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleExport}
            disabled={exportBusy || clips.length === 0}
          >
            {exportBusy ? (
              <>
                <span className="spinner" style={{ fontSize: '0.8rem' }} />
                {exportLabel}
              </>
            ) : (
              exportLabel
            )}
          </button>
        )}
      </div>

      <div className="editor-stage">
        {/* Hidden metadata probes — mounted so the browser keeps them alive
            until `loadedmetadata` reports each clip's real duration. Skipped
            entirely once a duration is known (server-provided or probed). */}
        {clips.map((c) =>
          fullFrames[c.id] ? null : (
            <video
              key={`probe-${c.id}`}
              src={c.videoUrl}
              preload="metadata"
              muted
              playsInline
              style={{ display: 'none' }}
              onLoadedMetadata={(e) => recordDuration(c.id, e.currentTarget.duration)}
              onError={() => recordDuration(c.id, FALLBACK_FRAMES / FPS)}
            >
              <track kind="captions" />
            </video>
          ),
        )}

        {/* Failed / in-progress clips — surfaced explicitly (never silently
            dropped). Each failed clip gets a "Re-animate" action; re-animation
            re-enters the animating stage (handled by the dispatcher). */}
        {(failedClips.length > 0 || pendingClips.length > 0) && (
          <div className="banner banner-warn editor-failed">
            <div className="editor-failed__head">
              {failedClips.length > 0
                ? `${failedClips.length} clip${failedClips.length > 1 ? 's' : ''} failed to animate.`
                : 'Some clips are still animating.'}{' '}
              {failedClips.length > 0 &&
                'Re-animate them to include them in your video, or export with the clips you have.'}
            </div>
            <ul className="editor-failed__list">
              {failedClips.map((c) => (
                <li key={c.id} className="editor-failed__item">
                  <span>Clip {c.idx + 1} — failed</span>
                  <button
                    type="button"
                    className="btn btn-ghost editor-failed__btn"
                    onClick={() => handleReanimate(c.id)}
                    disabled={reanimatingId != null}
                  >
                    {reanimatingId === c.id ? (
                      <>
                        <span className="spinner" style={{ fontSize: '0.75rem' }} /> Starting…
                      </>
                    ) : (
                      '↻ Re-animate'
                    )}
                  </button>
                </li>
              ))}
              {pendingClips.map((c) => (
                <li key={c.id} className="editor-failed__item">
                  <span>
                    <span className="spinner" style={{ fontSize: '0.75rem' }} /> Clip {c.idx + 1} —
                    animating…
                  </span>
                </li>
              ))}
            </ul>
            {reanimateError && (
              <div className="banner banner-error" style={{ fontSize: '0.8rem' }}>
                {reanimateError}
              </div>
            )}
          </div>
        )}

        {clips.length === 0 ? (
          <div className="banner banner-info">
            {failedClips.length > 0
              ? 'No usable clips yet — re-animate the failed clips above to build your video.'
              : 'No clips yet — they appear here once the animation stage finishes.'}
          </div>
        ) : allRemoved ? (
          <div className="banner banner-info" style={{ display: 'flex', gap: '0.75rem' }}>
            <span>You removed every clip. Restore them to build your video.</span>
            <button type="button" className="btn btn-ghost" onClick={restoreAll}>
              Restore all clips
            </button>
          </div>
        ) : !ready ? (
          <div className="banner banner-info">
            <span className="spinner" style={{ fontSize: '0.8rem' }} /> Loading clips…
          </div>
        ) : (
          <>
            <div className="player-wrap">
              <Player
                ref={playerRef}
                component={CojiEditorComposition}
                inputProps={{ clips: compositionClips, audioUrl: project.audioUrl }}
                durationInFrames={Math.max(total, 1)}
                compositionWidth={WIDTH}
                compositionHeight={HEIGHT}
                fps={FPS}
                style={{ width: '100%', aspectRatio: `${WIDTH}/${HEIGHT}` }}
              />
            </div>

            {/* Transport */}
            <div className="transport">
              <button
                type="button"
                className="transport__btn"
                onClick={() => seekToClip(Math.max(0, selected - 1))}
                disabled={selected <= 0}
                aria-label="Previous clip"
                title="Previous clip"
              >
                ⏮
              </button>
              <button
                type="button"
                className="transport__btn transport__btn--nudge"
                onClick={() => seekToFrame(frame - 1)}
                aria-label="Step back one frame"
                title="Step back one frame"
              >
                ◂
              </button>
              <button
                type="button"
                className="transport__play"
                onClick={togglePlay}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? '❚❚' : '►'}
              </button>
              <button
                type="button"
                className="transport__btn transport__btn--nudge"
                onClick={() => seekToFrame(frame + 1)}
                aria-label="Step forward one frame"
                title="Step forward one frame"
              >
                ▸
              </button>
              <button
                type="button"
                className="transport__btn"
                onClick={() => seekToClip(Math.min(segments.length - 1, selected + 1))}
                disabled={selected >= segments.length - 1}
                aria-label="Next clip"
                title="Next clip"
              >
                ⏭
              </button>
              <span className="transport__time">
                <span className="transport__time-now">{fmtTime(frame)}</span>
                <span className="transport__time-sep">/</span>
                <span className="transport__time-total">{fmtTime(total)}</span>
              </span>
              <span className="transport__meta">
                Clip {selected + 1} of {segments.length}
              </span>
            </div>

            {/* Timeline */}
            <div className="timeline2">
              <div className="timeline2__ruler" aria-hidden="true">
                {ticks.map((t) => (
                  <span
                    key={t.sec}
                    className={`timeline2__tick${t.major ? ' timeline2__tick--major' : ''}`}
                    style={{
                      left: `${Math.min(100, ((t.sec * FPS) / Math.max(1, total)) * 100)}%`,
                    }}
                  >
                    {t.major ? fmtTick(t.sec * FPS) : ''}
                  </span>
                ))}
              </div>

              <div
                ref={trackRef}
                className="timeline2__track"
                role="slider"
                aria-label="Timeline scrubber"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={frame}
                aria-valuetext={`${fmtTime(frame)} of ${fmtTime(total)}`}
                tabIndex={0}
                onPointerDown={handleTrackPointerDown}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    seekToFrame(frame + (e.shiftKey ? FPS : 1));
                  } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    seekToFrame(frame - (e.shiftKey ? FPS : 1));
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    seekToFrame(0);
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    seekToFrame(total);
                  } else if (e.key === ' ' || e.key === 'k') {
                    e.preventDefault();
                    togglePlay();
                  }
                }}
              >
                {segments.map((s, i) => {
                  const widthPct = (s.length / total) * 100;
                  const color = CLIP_COLORS[i % CLIP_COLORS.length]!;
                  const isFirst = i === 0;
                  const isLast = i === segments.length - 1;
                  return (
                    <div
                      key={s.clip.id}
                      className={`tl-clip${i === selected ? ' tl-clip--active' : ''}`}
                      style={{
                        width: `${widthPct}%`,
                        // Tinted body + a vivid spine so adjacent clips read as distinct.
                        background: `linear-gradient(180deg, ${color}33, ${color}1f)`,
                        ['--clip-color' as string]: color,
                      }}
                      title={`Clip ${i + 1} · ${fmtTime(s.length)} — drag to reorder`}
                      draggable
                      onDragStart={(e) => {
                        dragIdRef.current = s.clip.id;
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => {
                        if (dragIdRef.current && dragIdRef.current !== s.clip.id) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = dragIdRef.current;
                        dragIdRef.current = null;
                        if (from) reorderTo(from, s.clip.id);
                      }}
                      onDragEnd={() => {
                        dragIdRef.current = null;
                      }}
                    >
                      <span
                        className="tl-trim tl-trim--start"
                        onPointerDown={(e) => startTrimDrag(e, s.clip.id, 'start')}
                      />
                      <span className="tl-clip__poster" aria-hidden="true">
                        <video
                          src={s.clip.videoUrl}
                          muted
                          playsInline
                          preload="metadata"
                          tabIndex={-1}
                        >
                          <track kind="captions" />
                        </video>
                      </span>
                      <span className="tl-clip__label">
                        <span className="tl-clip__name">Clip {i + 1}</span>
                        <small>{fmtTime(s.length)}</small>
                      </span>
                      {/* Reorder / delete controls (a11y + non-drag fallback). */}
                      <span className="tl-clip__controls">
                        <button
                          type="button"
                          className="tl-clip__ctl"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => moveClip(s.clip.id, -1)}
                          disabled={isFirst}
                          aria-label={`Move clip ${i + 1} left`}
                          title="Move left"
                        >
                          ‹
                        </button>
                        <button
                          type="button"
                          className="tl-clip__ctl"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => moveClip(s.clip.id, 1)}
                          disabled={isLast}
                          aria-label={`Move clip ${i + 1} right`}
                          title="Move right"
                        >
                          ›
                        </button>
                        <button
                          type="button"
                          className="tl-clip__ctl tl-clip__ctl--del"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => deleteClip(s.clip.id)}
                          aria-label={`Remove clip ${i + 1}`}
                          title="Remove clip"
                        >
                          ✕
                        </button>
                      </span>
                      <span
                        className="tl-trim tl-trim--end"
                        onPointerDown={(e) => startTrimDrag(e, s.clip.id, 'end')}
                      />
                    </div>
                  );
                })}

                <div className="timeline2__playhead" style={{ left: `${playheadPct}%` }}>
                  <span className="timeline2__playhead-grab" />
                </div>
              </div>

              <div className="timeline2__actions">
                <button
                  type="button"
                  className="btn btn-primary timeline2__action"
                  onClick={runAutoTrim}
                  disabled={analyzing}
                  title="Trim each clip to where speech starts and ends"
                >
                  {analyzing ? (
                    <>
                      <span className="spinner" style={{ fontSize: '0.75rem' }} /> Analyzing…
                    </>
                  ) : (
                    '✂ Auto-trim silence'
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost timeline2__action"
                  onClick={undoTrims}
                  disabled={!canUndo}
                  title="Undo the last trim change (Ctrl/Cmd+Z)"
                >
                  ↶ Undo
                </button>
                <button
                  type="button"
                  className="btn btn-ghost timeline2__action"
                  onClick={resetTrims}
                  disabled={analyzing}
                  title="Reset all clips to their full length"
                >
                  Reset trims
                </button>
                {removed.size > 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost timeline2__action"
                    onClick={restoreAll}
                    title="Restore clips you removed"
                  >
                    ↺ Restore {removed.size} removed
                  </button>
                )}
                <span className="timeline2__save-status" aria-live="polite">
                  {saveState === 'saving' ? (
                    <>
                      <span className="spinner" style={{ fontSize: '0.7rem' }} /> Saving…
                    </>
                  ) : saveState === 'saved' ? (
                    'Trims saved'
                  ) : saveState === 'error' ? (
                    <span style={{ color: 'var(--color-danger)' }}>Couldn’t save trims</span>
                  ) : null}
                </span>
              </div>

              <div className="timeline2__downloads">
                <span className="timeline2__downloads-label">Download clip:</span>
                {segments.map((s, i) => (
                  <a
                    key={s.clip.id}
                    href={s.clip.videoUrl}
                    download={`clip-${i + 1}.mp4`}
                    className="btn btn-ghost timeline2__download"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ↓ {i + 1}
                  </a>
                ))}
              </div>
            </div>

            {exportState === 'error' && exportError && (
              <div className="banner banner-error" style={{ fontSize: '0.85rem' }}>
                {exportError}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
