/**
 * Remotion compositions for the P4 RenderProvider.
 *
 * This file is NOT imported at runtime — it is only referenced by its
 * filesystem path and bundled by @remotion/bundler when the provider runs.
 * Keep it out of the api tsconfig include (*.ts only); the bundler handles
 * JSX via its own webpack transform.
 *
 * Composition: `CojiClips`
 *   Accepts `inputProps` matching `CojiCompositionProps` (see below).
 *   Composes N clips in sequence via <Series>/<Series.Sequence> +
 *   <OffthreadVideo>, with an optional <Audio> track.
 *
 * Key constraints from render-spike (#10):
 *   - <OffthreadVideo src> MUST be an http(s) URL — file:// is rejected.
 *   - jsxImportSource:"remotion" crashes the webpack bundler (removes it).
 *   - react-jsx transform is used (tsconfig.base.json "jsx":"react-jsx").
 */

import { AbsoluteFill, Audio, Composition, OffthreadVideo, Series, registerRoot } from 'remotion';

// ---------------------------------------------------------------------------
// Props shape (must match RenderClipInput[] + RenderComposition in types.ts)
// ---------------------------------------------------------------------------

export interface CojiClipProps {
  /** Signed http(s) URL of the clip. Required — never a file:// path. */
  videoUrl: string;
  /** Duration of this clip in frames (required for Series.Sequence). */
  durationInFrames: number;
  /** Remotion startFrom: skip this many frames from the start of the clip. */
  startFrom?: number;
  /** Remotion endAt: stop playing at this frame within the clip. */
  endAt?: number;
}

export interface CojiCompositionProps {
  clips: CojiClipProps[];
  /** Optional audio track URL (TTS output or supplied audio_url). */
  audioUrl?: string;
}

// ---------------------------------------------------------------------------
// CojiClips component
// ---------------------------------------------------------------------------

function CojiClips({ clips, audioUrl }: CojiCompositionProps) {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Series>
        {clips.map((clip) => (
          <Series.Sequence
            key={`${clip.videoUrl}:${clip.startFrom ?? 0}`}
            durationInFrames={clip.durationInFrames}
          >
            <OffthreadVideo src={clip.videoUrl} startFrom={clip.startFrom} endAt={clip.endAt} />
          </Series.Sequence>
        ))}
      </Series>
      {audioUrl ? <Audio src={audioUrl} /> : null}
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------
// Root — registered via registerRoot (required by @remotion/bundler entry)
// ---------------------------------------------------------------------------

// Default props used by selectComposition; inputProps from the caller override.
const DEFAULT_PROPS: CojiCompositionProps = {
  clips: [{ videoUrl: '', durationInFrames: 30 }],
};

function RemotionRoot() {
  return (
    <Composition
      id="CojiClips"
      component={CojiClips}
      // durationInFrames / fps / width / height are overridden by inputProps at
      // render time via the `calculateMetadata` callback below.
      durationInFrames={30}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={({ props }) => {
        const totalFrames = props.clips.reduce((sum, c) => sum + c.durationInFrames, 0);
        return { durationInFrames: Math.max(totalFrames, 1) };
      }}
    />
  );
}

registerRoot(RemotionRoot);
