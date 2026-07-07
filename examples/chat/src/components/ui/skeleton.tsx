import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/** A pulsing placeholder block for loading states. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn("animate-pulse rounded-md bg-foreground/[0.07]", className)} style={style} />;
}
