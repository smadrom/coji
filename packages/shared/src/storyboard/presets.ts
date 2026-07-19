/**
 * Storyboard presets — the shared vocabulary of camera shots used by BOTH the
 * web UI (pick presets per frame) and the api (compose the image prompt). One
 * source of truth so the labels the user picks map exactly to the prompt text.
 *
 * A storyboard is `assistant` (let an LLM adapt each shot's action to the
 * prompt/script) + 4 frame configs, each = a shot preset id + optional camera
 * overrides + optional free-text action.
 */

export type ShotPresetId =
  | 'wide'
  | 'medium'
  | 'medium-close'
  | 'close-up'
  | 'extreme-close'
  | 'over-shoulder'
  | 'low-angle'
  | 'high-angle'
  | 'side-profile';

export type CameraDistance = 'closeup' | 'medium' | 'wide';
export type CameraAngle = 'eye' | 'low' | 'high' | 'dutch';
export type CameraHeight = 'low' | 'eye' | 'high';
export type CameraLens = 'wide' | 'normal' | 'tele';

export interface CameraSettings {
  distance?: CameraDistance;
  angle?: CameraAngle;
  height?: CameraHeight;
  lens?: CameraLens;
}

export interface ShotPreset {
  id: ShotPresetId;
  /** Human label for the UI (kept short). */
  label: string;
  /** Prompt fragment describing the framing. */
  framing: string;
  /** Default camera settings this preset implies. */
  camera: CameraSettings;
  /** Default subject action when the assistant is off and no custom action. */
  defaultAction: string;
  /**
   * Whether the subject's face is reliably present and framed in this shot.
   * HeyGen avatar_iv needs a visible face to animate — face-less shots
   * (e.g. over-the-shoulder) 400 and waste credits. The animate stage uses
   * this to skip/flag such shots before spending credits.
   */
  facePresent: boolean;
}

export const SHOT_PRESETS: ShotPreset[] = [
  {
    id: 'wide',
    label: 'Wide',
    framing: 'wide establishing shot, the whole scene visible, subject small in the frame',
    camera: { distance: 'wide', angle: 'eye', height: 'high', lens: 'wide' },
    defaultAction: 'sitting back and gesturing at the surroundings',
    facePresent: true,
  },
  {
    id: 'medium',
    label: 'Medium',
    framing: 'medium shot, head-to-waist, subject centred',
    camera: { distance: 'medium', angle: 'eye', height: 'eye', lens: 'normal' },
    defaultAction: 'talking warmly to the camera',
    facePresent: true,
  },
  {
    id: 'medium-close',
    label: 'Medium close-up',
    framing: 'medium close-up portrait, head and shoulders, shallow depth of field',
    camera: { distance: 'medium', angle: 'eye', height: 'eye', lens: 'normal' },
    defaultAction: 'leaning slightly toward the camera, excited',
    facePresent: true,
  },
  {
    id: 'close-up',
    label: 'Close-up',
    framing: 'close-up on the face, head fills most of the frame',
    camera: { distance: 'closeup', angle: 'eye', height: 'eye', lens: 'tele' },
    defaultAction: 'smiling with a knowing, delighted expression',
    facePresent: true,
  },
  {
    id: 'extreme-close',
    label: 'Extreme close-up',
    framing: 'extreme close-up, the face fills the frame, dramatic shallow focus',
    camera: { distance: 'closeup', angle: 'eye', height: 'eye', lens: 'tele' },
    defaultAction: 'reacting with wide eyes and an open-mouth smile',
    facePresent: true,
  },
  {
    id: 'over-shoulder',
    label: 'Over the shoulder',
    framing:
      'over-the-shoulder shot, the phone/screen large and sharp in the foreground, back of head and cheek visible',
    camera: { distance: 'medium', angle: 'low', height: 'low', lens: 'normal' },
    defaultAction: 'holding the phone out so the screen faces the camera, tapping it',
    // Over-the-shoulder shows the back of the head — no face to animate.
    facePresent: false,
  },
  {
    id: 'low-angle',
    label: 'Low angle',
    framing: 'low-angle shot looking up at the subject, dynamic and powerful',
    camera: { distance: 'medium', angle: 'low', height: 'low', lens: 'normal' },
    defaultAction: 'looking down toward the camera with a confident smile',
    facePresent: true,
  },
  {
    id: 'high-angle',
    label: 'High angle',
    framing: 'high-angle shot looking down at the subject',
    camera: { distance: 'medium', angle: 'high', height: 'high', lens: 'normal' },
    defaultAction: 'looking up at the camera, friendly',
    facePresent: true,
  },
  {
    id: 'side-profile',
    label: 'Side profile',
    framing: 'side profile, three-quarter turn, subject looking off to the side then to camera',
    camera: { distance: 'medium', angle: 'eye', height: 'eye', lens: 'normal' },
    defaultAction: 'turning from a side view to face the camera',
    facePresent: true,
  },
];

const PRESET_BY_ID = new Map(SHOT_PRESETS.map((p) => [p.id, p]));

/** The fallback preset (medium) — guaranteed defined. */
const FALLBACK_PRESET: ShotPreset =
  SHOT_PRESETS.find((p) => p.id === 'medium') ?? (SHOT_PRESETS[0] as ShotPreset);

export function getPreset(id: string): ShotPreset | undefined {
  return PRESET_BY_ID.get(id as ShotPresetId);
}

/** Resolve a preset id to a preset, falling back to medium. */
export function resolvePreset(id: string): ShotPreset {
  return PRESET_BY_ID.get(id as ShotPresetId) ?? FALLBACK_PRESET;
}

export interface FrameShot {
  /** A ShotPresetId; widened to string so external/TypeBox data flows in.
   *  Unknown ids resolve to the medium preset (see resolvePreset). */
  preset: string;
  camera?: CameraSettings;
  /** Free-text action override (what the subject is doing). */
  action?: string | null;
}

export interface Storyboard {
  /** When true, an LLM adapts each shot's action to the prompt/script. */
  assistant: boolean;
  frames: FrameShot[];
}

/**
 * A sensible default 4-frame storyboard: a varied progression.
 * Every preset here MUST be facePresent (HeyGen avatar_iv needs a visible
 * face); a face-less shot would 400 and waste credits on the default flow.
 */
export const DEFAULT_STORYBOARD: Storyboard = {
  assistant: true,
  frames: [
    { preset: 'medium-close' },
    { preset: 'wide' },
    { preset: 'extreme-close' },
    { preset: 'medium' },
  ],
};

const DISTANCE_TEXT: Record<CameraDistance, string> = {
  closeup: 'shot close to the subject',
  medium: 'shot at a medium distance',
  wide: 'shot from far away',
};
const ANGLE_TEXT: Record<CameraAngle, string> = {
  eye: 'eye-level angle',
  low: 'low camera angle',
  high: 'high camera angle',
  dutch: 'tilted dutch angle',
};
const HEIGHT_TEXT: Record<CameraHeight, string> = {
  low: 'camera placed low',
  eye: 'camera at eye height',
  high: 'camera placed high',
};
const LENS_TEXT: Record<CameraLens, string> = {
  wide: 'wide-angle lens',
  normal: 'normal lens',
  tele: 'telephoto lens with compressed perspective',
};

/** Compose the prompt framing text for one frame from its preset + camera. */
export function shotToFraming(shot: FrameShot): string {
  const preset = resolvePreset(shot.preset);
  const cam = { ...preset.camera, ...(shot.camera ?? {}) };
  const parts = [preset.framing];
  if (cam.distance) parts.push(DISTANCE_TEXT[cam.distance]);
  if (cam.angle) parts.push(ANGLE_TEXT[cam.angle]);
  if (cam.height) parts.push(HEIGHT_TEXT[cam.height]);
  if (cam.lens) parts.push(LENS_TEXT[cam.lens]);
  return parts.join(', ');
}

/** The default action for a frame (free-text override → preset default). */
export function shotDefaultAction(shot: FrameShot): string {
  if (shot.action?.trim()) return shot.action.trim();
  return resolvePreset(shot.preset).defaultAction;
}
