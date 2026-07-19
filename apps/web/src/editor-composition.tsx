/**
 * Browser-side Remotion composition for the editor Player preview.
 *
 * Uses <Video> (not <OffthreadVideo>) — <OffthreadVideo> requires the Remotion
 * server-side renderer (Chromium); in the browser Player we use the standard
 * HTML5 <Video> component which works everywhere.
 *
 * Shape mirrors remotion-compositions.tsx (server) so inputProps are compatible
 * with the RenderProvider's CojiCompositionProps.
 */

import { AbsoluteFill, Audio, Series, Video } from 'remotion';

export interface EditorClipProps {
  /** Signed http(s) URL of the clip. */
  videoUrl: string;
  /** Duration of this clip in frames (required for Series.Sequence). */
  durationInFrames: number;
  /** Skip this many frames from the start (Remotion startFrom). */
  startFrom?: number;
  /** Stop at this frame (Remotion endAt). */
  endAt?: number;
}

export interface EditorCompositionProps {
  clips: EditorClipProps[];
  /** Optional audio track URL. */
  audioUrl?: string;
}

/** Total frames across all clips. */
export function totalFrames(clips: EditorClipProps[]): number {
  return clips.reduce((sum, c) => sum + c.durationInFrames, 0);
}

export function CojiEditorComposition({ clips, audioUrl }: EditorCompositionProps) {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Series>
        {clips.map((clip, i) => (
          // index key is stable — clips are ordered and caller controls the array
          // biome-ignore lint/suspicious/noArrayIndexKey: ordered clip list, stable
          <Series.Sequence key={i} durationInFrames={clip.durationInFrames}>
            <Video
              src={clip.videoUrl}
              startFrom={clip.startFrom}
              endAt={clip.endAt}
              // COVER to match the ffmpeg export (fill the 9:16 frame, center-crop
              // overflow) so the editor preview is WYSIWYG with the rendered file.
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </Series.Sequence>
        ))}
      </Series>
      {audioUrl ? <Audio src={audioUrl} /> : null}
    </AbsoluteFill>
  );
}
