/**
 * Shot planner — turn a project prompt + a Storyboard (4 shot presets, optional
 * camera overrides, an assistant toggle) into per-frame prompts for the image
 * grid, plus a short label per frame for the UI caption.
 *
 * - Framing comes from the chosen preset + camera settings (shared/storyboard).
 * - Action: assistant ON + an LLM planner → the LLM adapts each action to the
 *   prompt/script; otherwise the preset default / the user's free-text action.
 * - Frame `label` is the preset's short name (e.g. "Wide", "Close-up") — used as
 *   the caption, instead of dumping the whole prompt into the UI.
 */
import {
  DEFAULT_STORYBOARD,
  type Storyboard,
  getPreset,
  shotDefaultAction,
  shotToFraming,
} from '@coji/shared/storyboard';

const CONSISTENCY =
  'Keep the SAME person (same face, hairstyle, outfit) and the same setting and lighting, but make this a clearly DIFFERENT camera shot from the others.';

/** One planned frame: the full generation prompt + a short UI label. */
export interface PlannedShot {
  prompt: string;
  label: string;
}

/**
 * An LLM action planner: given the concept + the chosen framings, returns one
 * *action* per framing (same length/order), or null to defer to defaults.
 * Must not throw for control flow — return null.
 */
export type ShotActionPlanner = (input: {
  prompt: string;
  script?: string | null;
  framings: string[];
}) => Promise<string[] | null>;

export interface PlanShotsOptions {
  storyboard?: Storyboard;
  script?: string | null;
  planner?: ShotActionPlanner;
}

function compose(basePrompt: string, framing: string, action: string): string {
  return `${basePrompt.trim()}. Shot: ${framing}. The subject is ${action}. ${CONSISTENCY}`;
}

export async function planShots(
  basePrompt: string,
  opts: PlanShotsOptions = {},
): Promise<PlannedShot[]> {
  const sb: Storyboard = opts.storyboard ?? DEFAULT_STORYBOARD;
  const frames = sb.frames.length > 0 ? sb.frames : DEFAULT_STORYBOARD.frames;

  const framings = frames.map(shotToFraming);
  let actions = frames.map(shotDefaultAction);

  if (sb.assistant && opts.planner) {
    const llm = await opts.planner({ prompt: basePrompt, script: opts.script, framings });
    if (
      Array.isArray(llm) &&
      llm.length === frames.length &&
      llm.every((s) => typeof s === 'string' && s.trim().length > 0)
    ) {
      actions = llm.map((s) => s.trim());
    }
  }

  return frames.map((f, i) => ({
    prompt: compose(basePrompt, framings[i] ?? '', actions[i] ?? ''),
    label: getPreset(f.preset)?.label ?? `Frame ${i + 1}`,
  }));
}
