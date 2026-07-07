import type { CSSProperties } from "react";

// Shared sizing/format for custom emoji, used by the composer atom, message
// rendering, and reactions so they all line up. Custom emoji are written into
// message bodies as `[:name:](emoji:<id>)` (mirroring the mention wire format)
// and stored as reactions under the value `custom:<id>`.

export const EMOJI_SIZE = 20; // inline emoji square (px) — ~1.3× the body type, and small enough to sit in a text line without forcing it taller (which would clip in the composer / scroll)
export const EMOJI_PAD = 5; // horizontal breathing room around an inline emoji
export const CUSTOM_PREFIX = "custom:";

/** What the picker hands back: a unicode grapheme or an orbit custom emoji. */
export type EmojiPick =
  | { type: "unicode"; char: string }
  | { type: "custom"; id: string; name: string; url: string };

/** The value stored in the `reactions.emoji` column for a pick. */
export function reactionValue(pick: EmojiPick): string {
  return pick.type === "unicode" ? pick.char : `${CUSTOM_PREFIX}${pick.id}`;
}

/** Split a stored reaction value into a custom-emoji id, or null if unicode. */
export function customIdOf(value: string): string | null {
  return value.startsWith(CUSTOM_PREFIX) ? value.slice(CUSTOM_PREFIX.length) : null;
}

export const customEmojiImgStyle: CSSProperties = {
  width: EMOJI_SIZE,
  height: EMOJI_SIZE,
  objectFit: "contain",
  verticalAlign: "middle",
  display: "inline-block",
};

// Unicode (system) emoji are rendered at the same square as custom emoji so a
// message with both reads uniformly. The glyph sits in an inline box exactly
// `EMOJI_SIZE + EMOJI_PAD` wide (mirroring the custom-emoji atom).
export const unicodeEmojiStyle: CSSProperties = {
  display: "inline-flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "center",
  fontSize: EMOJI_SIZE,
  lineHeight: 1,
  fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif',
};

// A grapheme counts as emoji if it presents as emoji by default, is explicitly
// emoji-presented (VS16 U+FE0F), is a flag (regional indicators), or is a ZWJ
// sequence (U+200D). Plain symbols like © ® ™ (no Emoji_Presentation, no VS16)
// stay text.
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\uFE0F|\u200D/u;
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export type EmojiSeg = { text: string } | { emoji: string };

/** Split a string into runs of plain text and standalone emoji graphemes. Fast
 *  path (the common case): no emoji → a single text run, no segmentation. */
export function splitEmoji(value: string): EmojiSeg[] {
  if (!value || !segmenter || !EMOJI_RE.test(value)) return [{ text: value }];
  const out: EmojiSeg[] = [];
  let buf = "";
  for (const { segment } of segmenter.segment(value)) {
    if (EMOJI_RE.test(segment)) {
      if (buf) {
        out.push({ text: buf });
        buf = "";
      }
      out.push({ emoji: segment });
    } else {
      buf += segment;
    }
  }
  if (buf) out.push({ text: buf });
  return out;
}
