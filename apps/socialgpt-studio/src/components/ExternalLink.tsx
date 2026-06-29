import type { ReactNode } from "react";
import { openExternal } from "../lib/external.js";

/**
 * A link that opens in the system browser even inside the desktop webview (where `target="_blank"`
 * is a no-op). Renders a real `<a href>` — so the URL is visible, copyable, and works for
 * middle-click in a plain browser — but on click routes through the backend `/open`.
 */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
