/**
 * ShareButton — share the current project's deep link.
 *
 * Uses the native share sheet (navigator.share) when available (mobile/PWA),
 * otherwise falls back to copying the URL to the clipboard with brief "Copied!"
 * feedback. The link is the deep-linkable /p/:id page, which is auth-gated — so
 * sharing is "send someone to this project", not a public asset URL.
 */

import { useState } from 'react';

interface Props {
  /** Absolute URL to share (defaults to the current page). */
  url?: string;
  /** Title used by the native share sheet. */
  title?: string;
}

export function ShareButton({ url, title = 'My coji video' }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    const shareUrl = url ?? window.location.href;
    const nav = navigator as Navigator & {
      share?: (data: { title?: string; url?: string }) => Promise<void>;
    };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title, url: shareUrl });
        return;
      } catch {
        // User dismissed the sheet, or share failed — fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. insecure context) — last resort: prompt select.
      window.prompt('Copy this link:', shareUrl);
    }
  }

  return (
    <button type="button" className="btn btn-ghost" onClick={handleShare}>
      {copied ? '✓ Link copied' : '🔗 Share'}
    </button>
  );
}
