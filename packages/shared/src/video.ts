/**
 * Output video format constants — a LEAF module with zero Node-only imports so
 * the browser bundle (vite/rollup) can import it directly. Importing these from
 * the package root (`@coji/shared`) would transitively pull the provider graph
 * (storage-local.ts → node:fs/path), which breaks the web build — so always
 * import from `@coji/shared/video`.
 *
 * Vertical 9:16 for TikTok / Reels / Shorts. Single source for the editor
 * preview composition AND the ffmpeg export, so the preview is WYSIWYG with the
 * exported file. Non-9:16 clips are cover-cropped (fill + center) to this frame.
 */
export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
export const VIDEO_FPS = 30;
