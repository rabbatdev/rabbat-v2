// A full-screen media viewer ("lightbox"). Any image/video in a message —
// attachments, direct-media embeds, or an X post's photo gallery — opens here.
// Provided once at the app root so it survives the virtualized list unmounting
// the row that opened it. Prev/next + arrow keys cycle a set; Esc / backdrop
// closes.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";

import { MessageImage } from "@/components/MessageImage";

export type LightboxItem = { url: string; kind: "image" | "video"; poster?: string };

const LightboxContext = createContext<{ open: (items: LightboxItem[], index: number) => void } | null>(null);

export function useLightbox() {
  return useContext(LightboxContext);
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<LightboxItem[] | null>(null);
  const [index, setIndex] = useState(0);

  const open = useCallback((it: LightboxItem[], i: number) => {
    if (!it.length) return;
    setItems(it);
    setIndex(Math.max(0, Math.min(i, it.length - 1)));
  }, []);
  const close = useCallback(() => setItems(null), []);
  const n = items?.length ?? 0;
  const go = useCallback((d: number) => setIndex((i) => (n ? (i + d + n) % n : 0)), [n]);

  useEffect(() => {
    if (!items) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [items, close, go]);

  const cur = items?.[index];

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {cur &&
        createPortal(
          <div
            className="animate-in-fast fixed inset-0 z-[120] flex items-center justify-center bg-black/90 backdrop-blur-sm"
            onClick={close}
          >
            <div className="absolute right-[calc(var(--sar)_+_1rem)] top-[calc(var(--sat)_+_1rem)] z-10 flex items-center gap-2">
              <a
                href={cur.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label="Open original"
                className="grid size-10 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              >
                <ExternalLink className="size-[18px]" />
              </a>
              <button
                type="button"
                aria-label="Close"
                onClick={close}
                className="grid size-10 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              >
                <X className="size-5" />
              </button>
            </div>

            {n > 1 && (
              <div className="absolute left-1/2 top-[calc(var(--sat)_+_1.25rem)] -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-[13px] font-medium tabular-nums text-white">
                {index + 1} / {n}
              </div>
            )}

            {n > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Previous"
                  onClick={(e) => {
                    e.stopPropagation();
                    go(-1);
                  }}
                  className="absolute left-3 top-1/2 grid size-12 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                  <ChevronLeft className="size-7" />
                </button>
                <button
                  type="button"
                  aria-label="Next"
                  onClick={(e) => {
                    e.stopPropagation();
                    go(1);
                  }}
                  className="absolute right-3 top-1/2 grid size-12 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                  <ChevronRight className="size-7" />
                </button>
              </>
            )}

            <div className="max-h-[90vh] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
              {cur.kind === "video" ? (
                <video
                  key={cur.url}
                  src={cur.url}
                  poster={cur.poster}
                  controls
                  autoPlay
                  playsInline
                  className="max-h-[90vh] max-w-[92vw] rounded-lg bg-black shadow-2xl"
                />
              ) : (
                <MessageImage
                  key={cur.url}
                  src={cur.url}
                  className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
                />
              )}
            </div>
          </div>,
          document.body,
        )}
    </LightboxContext.Provider>
  );
}
