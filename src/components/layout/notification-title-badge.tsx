"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Strips a previously-applied "(N) " badge back off, so re-applying
 *  never compounds into "(1) (1) Bandeja...". */
const BADGE_PREFIX = /^\(\d+\)\s/;

/**
 * Gmail-style unread badge on the browser tab title — "(N) " prefixed
 * onto whatever title the current page already has. Headless, renders
 * nothing.
 *
 * Takes the count as a prop rather than calling `useUnreadNotifications`
 * itself — that hook opens its own realtime channel + fires its own
 * initial count query, and this is mounted alongside the sidebar (which
 * already needs the same value), so a second independent subscription
 * would double that load on every dashboard mount for no reason. Share
 * the one call from `DashboardShellInner` instead.
 *
 * Re-applies on every route change too, not just on count change: Next
 * resets `document.title` to the page's clean SSR title on navigation,
 * which would otherwise silently drop the badge on a page that didn't
 * itself change the unread count.
 *
 * Sets `document.title` synchronously in the effect — no
 * requestAnimationFrame defer. rAF callbacks are throttled to near-zero
 * in background tabs, so a notification arriving while this tab isn't
 * focused would sit un-applied until something else (a manual reload)
 * happened to repaint — exactly the case this badge exists for.
 */
export function NotificationTitleBadge({ unread }: { unread: number }) {
  const pathname = usePathname();

  useEffect(() => {
    const base = document.title.replace(BADGE_PREFIX, "");
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [unread, pathname]);

  return null;
}
