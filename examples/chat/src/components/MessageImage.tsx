import { useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";

import { cn } from "@/lib/utils";

const MAX_RETRIES = 4;
// Backoff between reload attempts: 0.5s, 1s, 2s, 4s.
const retryDelay = (n: number) => Math.min(500 * 2 ** (n - 1), 4000);

/**
 * An `<img>` that heals transient load failures on its own.
 *
 * Uploaded media lives on the uploadthing CDN, whose URL can briefly 403/404
 * right after upload (before the object is globally fetchable) or flake under
 * load. The browser caches that failed response, so the image — and the lightbox
 * that reuses the same URL — stay blank until a manual refresh. Here we catch
 * `onError` and reload a few times with a cache-busting query param (a plain
 * retry of the same URL would just re-serve the cached failure), which makes the
 * image reappear within a couple of seconds. After the retries are exhausted we
 * show a tap-to-retry placeholder instead of an empty box.
 */
export function MessageImage({
  src,
  alt = "",
  className,
  style,
  onClick,
}: {
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const [version, setVersion] = useState(0); // 0 = original URL; >0 = cache-busted reload
  const [failed, setFailed] = useState(false);
  const tries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Reset when the source changes (gallery swap, a row reused by virtualization).
  useEffect(() => {
    tries.current = 0;
    setVersion(0);
    setFailed(false);
    return () => clearTimeout(timer.current);
  }, [src]);

  const url = version === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}cb=${version}`;

  function onError() {
    if (tries.current >= MAX_RETRIES) {
      setFailed(true);
      return;
    }
    tries.current += 1;
    const next = tries.current;
    timer.current = setTimeout(() => setVersion(next), retryDelay(next));
  }

  function retryNow(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    tries.current = 0;
    setFailed(false);
    setVersion((v) => v + 1);
  }

  if (failed) {
    return (
      <button
        type="button"
        onClick={retryNow}
        style={style}
        className={cn(
          "grid place-items-center gap-1 bg-elevated text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
      >
        <ImageOff className="size-4" />
        Tap to retry
      </button>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      referrerPolicy="no-referrer"
      onClick={onClick}
      onError={onError}
      className={className}
      style={style}
    />
  );
}
