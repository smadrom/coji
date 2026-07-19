/**
 * Remotion root — registers the two compositions used by the smoke test.
 * The Composite's default props are placeholders; the smoke runner overrides
 * `clipSrc`/`audioSrc` with real file:// URLs via inputProps.
 */
import { Composition } from 'remotion';
import { CLIP_DURATION, Composite, FPS, HEIGHT, SolidClip, WIDTH } from './compositions.tsx';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="SolidClip"
        component={SolidClip}
        durationInFrames={CLIP_DURATION}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="Composite"
        // Remotion's Composition generic expects a Zod schema; this spike has
        // none, so cast the typed component to the loose component type.
        component={Composite as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={CLIP_DURATION}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ clipSrc: '', audioSrc: '' } as Record<string, unknown>}
      />
    </>
  );
};
