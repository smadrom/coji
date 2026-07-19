/**
 * StoryboardEditor — pick the 4 shots for a project: an AI-assistant toggle and,
 * per frame, a shot preset + optional camera settings. Shared `SHOT_PRESETS`
 * keep the labels in sync with what the api turns into prompts.
 *
 * Used on /new (set defaults before Generate) and on the review screen (edit +
 * regenerate). Controlled: parent owns the `Storyboard` value.
 */

import {
  type CameraAngle,
  type CameraDistance,
  type CameraHeight,
  type CameraLens,
  SHOT_PRESETS,
  type Storyboard,
} from '@coji/shared/storyboard';

interface Props {
  value: Storyboard;
  onChange: (next: Storyboard) => void;
  disabled?: boolean;
}

const DISTANCES: CameraDistance[] = ['closeup', 'medium', 'wide'];
const ANGLES: CameraAngle[] = ['eye', 'low', 'high', 'dutch'];
const HEIGHTS: CameraHeight[] = ['low', 'eye', 'high'];
const LENSES: CameraLens[] = ['wide', 'normal', 'tele'];

export function StoryboardEditor({ value, onChange, disabled }: Props) {
  function patchFrame(idx: number, patch: Partial<Storyboard['frames'][number]>) {
    const frames = value.frames.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    onChange({ ...value, frames });
  }
  function patchCamera(idx: number, patch: Record<string, string>) {
    const frame = value.frames[idx];
    const camera = { ...(frame?.camera ?? {}), ...patch };
    patchFrame(idx, { camera });
  }

  return (
    <div className="storyboard">
      <label className="storyboard__toggle">
        <input
          type="checkbox"
          checked={value.assistant}
          onChange={(e) => onChange({ ...value, assistant: e.target.checked })}
          disabled={disabled}
          data-testid="assistant-toggle"
        />
        <span>
          <strong>AI assistant</strong> — adapt each shot's action to your prompt/script
        </span>
      </label>

      <div className="storyboard__frames">
        {value.frames.map((frame, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional shot slots
          <div key={`shot-${idx}`} className="storyboard__frame" data-testid="storyboard-frame">
            <div className="storyboard__frame-head">Frame {idx + 1}</div>
            <label className="storyboard__field">
              <span>Shot</span>
              <select
                value={frame.preset}
                onChange={(e) => patchFrame(idx, { preset: e.target.value })}
                disabled={disabled}
                data-testid={`preset-${idx}`}
              >
                {SHOT_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <details className="storyboard__camera">
              <summary>Camera</summary>
              <div className="storyboard__camera-grid">
                <CamSelect
                  label="Distance"
                  options={DISTANCES}
                  value={frame.camera?.distance}
                  onChange={(v) => patchCamera(idx, { distance: v })}
                  disabled={disabled}
                />
                <CamSelect
                  label="Angle"
                  options={ANGLES}
                  value={frame.camera?.angle}
                  onChange={(v) => patchCamera(idx, { angle: v })}
                  disabled={disabled}
                />
                <CamSelect
                  label="Height"
                  options={HEIGHTS}
                  value={frame.camera?.height}
                  onChange={(v) => patchCamera(idx, { height: v })}
                  disabled={disabled}
                />
                <CamSelect
                  label="Lens"
                  options={LENSES}
                  value={frame.camera?.lens}
                  onChange={(v) => patchCamera(idx, { lens: v })}
                  disabled={disabled}
                />
              </div>
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}

function CamSelect({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: string[];
  value: string | undefined;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="storyboard__field">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">auto</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
