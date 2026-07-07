import { useConnectionStatus } from "@rabbat/react";
import { cn } from "@/lib/utils";

const META: Record<string, { label: string; dot: string }> = {
  open: { label: "Live", dot: "bg-success" },
  connecting: { label: "Connecting", dot: "bg-amber-500 animate-pulse" },
  closed: { label: "Offline", dot: "bg-muted-foreground" },
};

export function ConnectionBadge() {
  const status = useConnectionStatus();
  const meta = META[status] ?? META.closed;
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}
