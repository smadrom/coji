/**
 * Provider seam contracts — the single source of truth shared by the API
 * runtime and tests. Every paid external API sits behind one of these
 * interfaces; each ships with a deterministic Noop/local fake (see ./noop.ts
 * and ./storage-local.ts) so CI never calls a paid API.
 *
 * Shapes are aligned with the verified provider payloads recorded in
 * docs/api-verification.md (Gemini image, HeyGen v3 image-to-video, Remotion).
 */
import type { JobKind } from '../index.ts';

// --------------------------------------------------------------------------
// StorageProvider — object storage (S3/R2) with a local-filesystem fake.
//   frames.image_ref = storage key; clips.video_url / renders.output_url =
//   signed/public URL (ADR-5).
// --------------------------------------------------------------------------

export interface StoredObject {
  /** Storage key (object key) — what `frames.image_ref` holds. */
  key: string;
  contentType: string;
  size: number;
}

/**
 * A streamed (optionally partial) read of an object. Lets `/files` proxy a
 * Range request straight to the backing store instead of buffering the whole
 * object into API memory (F1). For a ranged read, `start`/`end` are the
 * inclusive byte bounds actually served and `totalSize` is the full object
 * size (used to build the `Content-Range` header).
 */
export interface StorageRange {
  /** The bytes for the requested range (or the whole object). */
  stream: ReadableStream<Uint8Array>;
  /** Number of bytes in `stream` (the `Content-Length` of the response). */
  contentLength: number;
  /** Full object size in bytes (the `/total` in `Content-Range`). */
  totalSize: number;
  /** First byte index served (0 for a full read). */
  start: number;
  /** Last byte index served, inclusive (`totalSize - 1` for a full read). */
  end: number;
  /** Content-type the store recorded, if any (callers may still sniff). */
  contentType?: string;
}

export interface StorageProvider {
  /** Store bytes under `key`; returns the stored-object descriptor. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredObject>;
  /**
   * Mint a URL that is HTTP-reachable for at least `ttlSeconds`. Consumers
   * (HeyGen pass-through, Remotion OffthreadVideo) fetch over this URL, so the
   * TTL must outlive their fetch window (M2). Preview URLs are regenerated on
   * demand rather than relying on a long TTL.
   */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Read the bytes back (used to upload frame bytes to HeyGen /v3/assets). */
  getBytes(key: string): Promise<Uint8Array>;
  /**
   * Stream an object (or a single inclusive byte range of it) without buffering
   * the whole object in memory. `start`/`end` are inclusive byte offsets; omit
   * both for a full read. An `end` past the object end is clamped. Used by the
   * `/files` route to serve `<video>` Range requests straight from the store.
   */
  getRange(key: string, start?: number, end?: number): Promise<StorageRange>;
  /** True if an object exists at `key`. */
  exists(key: string): Promise<boolean>;
}

// --------------------------------------------------------------------------
// ImageProvider — prompt → 4 same-person frames (Gemini-native default).
// --------------------------------------------------------------------------

export interface GeneratedFrame {
  /** 0–3 — position in the 4-frame set. */
  idx: number;
  /** Raw image bytes (decoded from the provider's base64 inline data). */
  bytes: Uint8Array;
  contentType: string;
  caption: string;
}

export interface ImageGenerateOptions {
  /** Number of frames to produce (the product default is 4). */
  frameCount?: number;
  /** Opaque per-project seed so fakes are deterministic across a project. */
  seed?: string;
  /**
   * Per-frame shot prompts (a storyboard): `shotPrompts[idx]` describes the
   * camera angle + action for frame `idx`, so the 4 frames are DIFFERENT shots
   * of the same person/scene rather than near-duplicates. When provided, the
   * provider uses these instead of repeating the base prompt. Length should be
   * `frameCount`; providers fall back to the base prompt for any missing index.
   */
  shotPrompts?: string[];
  /** Short per-frame labels (e.g. "Wide", "Close-up") used as the caption. */
  shotLabels?: string[];
  /** Per-call model override (quality modes). Falls back to the provider default. */
  model?: string;
}

export interface ImageProvider {
  /**
   * Generate `frameCount` (default 4) consistent frames for `prompt`. The real
   * Gemini provider feeds frame 1 back as a reference for frames 2–4; fakes
   * produce deterministic output.
   */
  generate(prompt: string, opts?: ImageGenerateOptions): Promise<GeneratedFrame[]>;
}

// --------------------------------------------------------------------------
// AnimationProvider — image-to-video (HeyGen v3, async).
//   submit() returns an external job id; the runner later resolves the result
//   via fetchResult() (reconciler/poll path) or a webhook carries it.
// --------------------------------------------------------------------------

/** TTS audio source: HeyGen `script` + `voice_id`. */
export interface TtsAudioSpec {
  mode: 'tts';
  script: string;
  voiceId: string;
}

/** Pre-supplied audio source: HeyGen `audio_url`. */
export interface UrlAudioSpec {
  mode: 'audio_url';
  audioUrl: string;
}

export type AudioSpec = TtsAudioSpec | UrlAudioSpec;

export interface AnimationSubmitInput {
  /** Storage key of the source frame (bytes uploaded to /v3/assets). */
  frameRef: string;
  audio: AudioSpec;
  /** HeyGen `resolution`: '4k' | '1080p' | '720p'. */
  resolution?: string;
  /** HeyGen `aspect_ratio`: 'auto' | '16:9' | '9:16' | '4:5' | '5:4' | '1:1'. */
  aspectRatio?: string;
  /** Webhook URL HeyGen POSTs to on completion (`callback_url`). */
  callbackUrl?: string;
  /** Encodes the `provider_jobs.id` (attempt row) — round-trip correlation. */
  callbackId: string;
}

export type AnimationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface AnimationResult {
  externalId: string;
  status: AnimationStatus;
  /** Presigned download URL, present when status === 'completed'. */
  videoUrl?: string;
  /** Real clip length in seconds (HeyGen `duration`), present when known. */
  durationSeconds?: number;
  failureCode?: string;
  failureMessage?: string;
}

export interface AnimationProvider {
  /** Submit one image-to-video job; returns the provider's external job id. */
  submit(input: AnimationSubmitInput): Promise<{ externalId: string }>;
  /** Resolve current status/result for a previously-submitted job (poll path). */
  fetchResult(externalId: string): Promise<AnimationResult>;
}

// --------------------------------------------------------------------------
// RenderProvider — composition → final video (Remotion local/Lambda).
// --------------------------------------------------------------------------

export interface RenderClipInput {
  /** Signed URL of the source clip fed to OffthreadVideo. */
  videoUrl: string;
  /** Optional per-clip trim (Remotion startFrom/endAt), in frames. */
  startFrom?: number;
  endAt?: number;
}

export interface RenderComposition {
  clips: RenderClipInput[];
  /** Optional audio track URL (TTS-generated or supplied audio_url). */
  audioUrl?: string;
  fps?: number;
  width?: number;
  height?: number;
}

export interface RenderResult {
  /** Raw bytes of the rendered output (caller persists via StorageProvider). */
  bytes: Uint8Array;
  contentType: string;
  durationInFrames: number;
}

export interface RenderProvider {
  render(composition: RenderComposition): Promise<RenderResult>;
}

// --------------------------------------------------------------------------
// Provider bundle — what the config factory resolves and hands to the runner.
// --------------------------------------------------------------------------

export interface Providers {
  image: ImageProvider;
  animation: AnimationProvider;
  render: RenderProvider;
  storage: StorageProvider;
}

/** Maps a job kind to its paid provider seam (documentation aid). */
export type ProviderForKind<K extends JobKind> = K extends 'image'
  ? ImageProvider
  : K extends 'animation'
    ? AnimationProvider
    : RenderProvider;
