import type { CSSProperties } from "react";

// Shared look for an @mention chip, used by BOTH the ori chat input (a real-DOM
// inline atom) and rendered messages (a mugen-markdown inline box), so they're
// pixel-identical. `MENTION_FONT` sizes both the canvas measurement and the
// painted text; `MENTION_PAD` is the px reserved around the text for padding.
export const MENTION_FONT = "600 14px Geist";
export const MENTION_PAD = 14;

export const mentionChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
  width: "100%",
  whiteSpace: "nowrap",
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.5,
  padding: "0 6px",
  borderRadius: 6,
  background: "oklch(0.64 0.196 300 / 0.16)",
  color: "var(--primary)",
};
