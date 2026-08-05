"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";

/** Strips a previously-applied "(N) " badge back off, so re-applying
 *  never compounds into "(1) (1) Bandeja...". */
const BADGE_PREFIX = /^\(\d+\)\s/;

/**
 * Gmail-style unread badge on the browser tab title — "(N) " prefixed
 * onto whatever title the current page already has. Headless, renders
 * nothing.
 *
 * Re-applies on every route change too, not just on count change: Next
 * resets `document.title` to the page's clean SSR title on navigation,
 * which would otherwise silently drop the badge on a page that didn't
 * itself change the unread count. Deferred a tick so it reasserts
 * itself after Next's own title update on the same navigation, rather
 * than racing it.
 */
export function NotificationTitleBadge() {
  const unread = useUnreadNotifications();
  const pathname = usePathname();

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const base = document.title.replace(BADGE_PREFIX, "");
      document.title = unread > 0 ? `(${unread}) ${base}` : base;
    });
    return () => cancelAnimationFrame(id);
  }, [unread, pathname]);

  return null;
}
