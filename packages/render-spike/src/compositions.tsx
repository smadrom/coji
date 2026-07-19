/**
 * Remotion compositions for the P4 render smoke test.
 *
 * - `SolidClip`: a synthetic ~1s animated solid-colour clip. Rendering this
 *   first proves basic server-side rendering works and gives us a real mp4 to
 *   feed into the risky path below.
 * - `Composite`: pulls that mp4 back in through <OffthreadVideo> inside a
 *   <Series.Sequence>, plus an <Audio> track — the exact compositing path the
 *   production editor/export depends on (ADR-3 / ADR-5).
 */
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Series,
  interpolate,
  useCurrentFrame,
} from 'remotion';

export const FPS = 30;
export const WIDTH = 320;
export const HEIGHT = 240;
export const CLIP_DURATION = 30; // ~1s at 30fps

function SolidClipInner() {
  const frame = useCurrentFrame();
  // Animate the hue so the render isn't a single static frame.
  const hue = interpolate(frame, [0, CLIP_DURATION], [200, 320]);
  return (
    <AbsoluteFill
      style={{
        backgroundColor: `hsl(${hue}, 80%, 50%)`,
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontSize: 48,
        fontFamily: 'sans-serif',
      }}
    >
      {frame}
    </AbsoluteFill>
  );
}

export const SolidClip: React.FC = () => <SolidClipInner />;

export interface CompositeProps {
  /** file:// or http(s):// URL of the clip produced by the SolidClip render. */
  clipSrc: string;
  /** file:// or http(s):// URL of the audio track. */
  audioSrc: string;
}

export const Composite: React.FC<CompositeProps> = ({ clipSrc, audioSrc }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Series>
        <Series.Sequence durationInFrames={CLIP_DURATION}>
          {/* The risky path: composite an EXTERNAL clip via OffthreadVideo. */}
          <OffthreadVideo src={clipSrc} />
        </Series.Sequence>
      </Series>
      <Audio src={audioSrc} />
    </AbsoluteFill>
  );
};
