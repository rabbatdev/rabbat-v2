import type * as React from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@rabbat/react";
import { Bold, Code, CornerUpLeft, ImagePlus, Italic, Loader2, Paperclip, Pencil, Play, Quote, SendHorizontal, Smile, Strikethrough, X } from "lucide-react";
import { NoteEditor, useEditor, useEditorSnapshot, useActiveMarks, type AtomRenderer, type NoteEditorHandle } from "@wingleeio/ori-react";
import {
  DEFAULT_TYPOGRAPHY,
  blockText,
  blockType,
  createBlock,
  createNoteDoc,
  fullAttributes,
  getBlocks,
  isCollapsed,
  resolveFont,
  type BlockType,
  type EditorSchema,
  type Marks,
} from "@wingleeio/ori-core";
import "@wingleeio/ori-react/styles.css";

import { api, type Member } from "@/rabbat";
import { useUploadThing } from "@/lib/uploadthing";
import { MENTION_PAD, mentionChipStyle } from "@/lib/mention";
import { EMOJI_PAD, EMOJI_SIZE, customEmojiImgStyle, splitEmoji, unicodeEmojiStyle, type EmojiPick } from "@/lib/emoji";
import { searchEmoji } from "@/lib/emoji-data";
import { EmojiPicker } from "./EmojiPicker";
import { useOrbit } from "@/context/orbit-context";
import type { EditTarget, ReplyTarget } from "./MessageList";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage, bodyPreview, initials, userColor } from "@/lib/util";

// Inline atoms (mentions + custom emoji) need a measured width so Pretext can
// lay them out inline. Custom emoji are a fixed square.
const ORI_SCHEMA: Partial<EditorSchema> = {
  atoms: {
    mention: {
      type: "mention",
      measure: ({ data, typography, measurer }) => {
        const label = String((data as { label?: string }).label ?? "");
        const font = resolveFont({ ...typography, fontSize: 14, fontWeight: 600 }, {});
        return Math.ceil(measurer.measure(`@${label}`, font)) + MENTION_PAD;
      },
    },
    emoji: {
      type: "emoji",
      measure: () => EMOJI_SIZE + EMOJI_PAD,
    },
    // System (unicode) emoji are atoms too, so they render at the same square as
    // custom emoji in the editor (matching how the message body renders them).
    uemoji: {
      type: "uemoji",
      measure: () => EMOJI_SIZE + EMOJI_PAD,
    },
  },
};
// ori MEASURES text at this typography but the browser RENDERS the
// contentEditable from CSS — the two must match exactly or the caret/selection
// drift from the glyphs (worst on touch, where you tap to place the caret). So
// these mirror the `.ori-chat .ori-ce` CSS: 16px (also dodges iOS's sub-16px
// auto-zoom) at line-height 1.6 — matching ori-react's `.ori-block` min-height of
// 1.6em so the measured and rendered line heights agree (a smaller value makes
// the snapshot-sized wrapper shorter than the block and clips it), Geist.
const ORI_TYPO = { ...DEFAULT_TYPOGRAPHY, fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif", fontSize: 16, lineHeight: 1.6 };

const atomRenderers: Record<string, AtomRenderer> = {
  mention: ({ atom }) => <span style={mentionChipStyle}>@{String((atom.data as { label?: string }).label ?? "")}</span>,
  emoji: ({ atom }) => {
    const data = atom.data as { name?: string; url?: string };
    return (
      <span style={{ display: "inline-flex", width: "100%", alignItems: "center", justifyContent: "center" }}>
        <img src={data.url} alt={`:${data.name ?? "emoji"}:`} style={customEmojiImgStyle} referrerPolicy="no-referrer" draggable={false} />
      </span>
    );
  },
  uemoji: ({ atom }) => <span style={unicodeEmojiStyle}>{String((atom.data as { char?: string }).char ?? "")}</span>,
};

// Wrap a marked run in markdown delimiters, keeping any leading/trailing
// whitespace OUTSIDE the delimiters — `** bold **` is not valid CommonMark
// emphasis (it renders the literal asterisks), but ` **bold** ` is.
function wrapRun(text: string, a: Record<string, unknown>): string {
  if (!text) return "";
  const lead = (text.match(/^\s*/) ?? [""])[0];
  const trail = text.length > lead.length ? (text.match(/\s*$/) ?? [""])[0] : "";
  let core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text; // whitespace-only run
  if (a.code) core = "`" + core + "`";
  if (a.strike) core = "~~" + core + "~~";
  if (a.italic) core = "*" + core + "*";
  if (a.bold) core = "**" + core + "**";
  return lead + core + trail;
}

// Serialize the ori document to markdown: text runs → markdown marks, mention
// atoms → `[@Name](mention:userId)` links. Consecutive runs that share the same
// marks are merged so a bold phrase becomes one `**…**` rather than per-op
// fragments like `**hello**** ****world**` (which CommonMark won't bold).
function editorToMarkdown(doc: ReturnType<typeof createNoteDoc>): string {
  const sigOf = (a: Record<string, unknown>) => `${!!a.bold}|${!!a.italic}|${!!a.code}|${!!a.strike}`;
  return getBlocks(doc)
    .toArray()
    .map((b) => {
      const type = blockType(b);
      const delta = blockText(b).toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
      const parts: string[] = [];
      let cur: { text: string; sig: string; a: Record<string, unknown> } | null = null;
      const flush = () => {
        if (cur) parts.push(wrapRun(cur.text, cur.a));
        cur = null;
      };
      for (const op of delta) {
        if (typeof op.insert === "string") {
          const a = op.attributes ?? {};
          const sig = sigOf(a);
          if (cur && cur.sig === sig) cur.text += op.insert;
          else {
            flush();
            cur = { text: op.insert, sig, a };
          }
        } else {
          flush();
          const m = op.insert as { type?: string; label?: string; id?: string; name?: string; char?: string };
          if (m?.type === "mention" && m.id) parts.push(`[@${m.label ?? "user"}](mention:${m.id})`);
          else if (m?.type === "emoji" && m.id) parts.push(`[:${m.name ?? "emoji"}:](emoji:${m.id})`);
          else if (m?.type === "uemoji" && m.char) parts.push(m.char);
        }
      }
      flush();
      let s = parts.join("");
      if (type === "quote") s = s ? "> " + s.replace(/\n/g, "\n> ") : s;
      else if (type === "heading") s = "## " + s;
      else if (type === "code") s = "```\n" + s + "\n```";
      return s;
    })
    .join("\n\n")
    .trim();
}

// ── Markdown → ori document (the inverse of editorToMarkdown) ────────────────
// When opening a message for editing, the stored body is markdown. Rebuild the
// editor's rich doc so marks render as live formatting and `[@x](mention:id)`
// renders as a mention chip — not as raw `**…**` / `[…](mention:…)` source text.
type Run = { text?: string; marks?: Marks; mention?: { label: string; id: string }; emoji?: { name: string; id: string } };

// Tried left-to-right at each position; longest/most-specific first. Mirrors the
// exact subset editorToMarkdown can emit (mentions + custom emoji + bold/italic/
// strike/code).
const INLINE_RULES: Array<{ re: RegExp; run: (m: RegExpExecArray) => Run }> = [
  { re: /^\[@([^\]]+)\]\(mention:([^)\s]+)\)/, run: (m) => ({ mention: { label: m[1], id: m[2] } }) },
  { re: /^\[:([^\]]+):\]\(emoji:([^)\s]+)\)/, run: (m) => ({ emoji: { name: m[1], id: m[2] } }) },
  { re: /^`([^`]+)`/, run: (m) => ({ text: m[1], marks: { code: true } }) },
  { re: /^\*\*\*([^*]+)\*\*\*/, run: (m) => ({ text: m[1], marks: { bold: true, italic: true } }) },
  { re: /^\*\*([^*]+)\*\*/, run: (m) => ({ text: m[1], marks: { bold: true } }) },
  { re: /^~~([^~]+)~~/, run: (m) => ({ text: m[1], marks: { strike: true } }) },
  { re: /^\*([^*]+)\*/, run: (m) => ({ text: m[1], marks: { italic: true } }) },
];

function parseInline(s: string): Run[] {
  const runs: Run[] = [];
  let plain = "";
  const flush = () => {
    if (plain) runs.push({ text: plain });
    plain = "";
  };
  for (let i = 0; i < s.length; ) {
    const rest = s.slice(i);
    let hit: Run | null = null;
    let len = 0;
    for (const { re, run } of INLINE_RULES) {
      const m = re.exec(rest);
      if (m) {
        hit = run(m);
        len = m[0].length;
        break;
      }
    }
    if (hit) {
      flush();
      runs.push(hit);
      i += len;
    } else {
      plain += s[i];
      i += 1;
    }
  }
  flush();
  return runs;
}

type EmojiMap = Map<string, { name: string; url: string }>;

function bodyToDoc(body: string, emojiById: EmojiMap): ReturnType<typeof createNoteDoc> {
  const doc = createNoteDoc();
  const blocks = getBlocks(doc);
  blocks.delete(0, blocks.length); // drop the seeded empty paragraph
  for (const chunk of body.split(/\n{2,}/)) {
    let type: BlockType = "paragraph";
    let content = chunk;
    let raw = false; // code blocks: no inline markdown inside
    if (/^>\s?/.test(chunk)) {
      type = "quote";
      content = chunk.replace(/^>\s?/gm, "");
    } else if (/^#{1,6}\s/.test(chunk)) {
      type = "heading";
      content = chunk.replace(/^#{1,6}\s+/, "");
    } else if (/^```/.test(chunk)) {
      type = "code";
      raw = true;
      content = chunk.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const block = createBlock(type);
    blocks.push([block]);
    const text = blockText(block);
    let at = 0;
    const insertPlain = (s: string) => {
      text.insert(at, s, fullAttributes({}));
      at += s.length;
    };
    for (const run of raw ? [{ text: content } as Run] : parseInline(content)) {
      if (run.mention) {
        text.insertEmbed(at, { type: "mention", label: run.mention.label, id: run.mention.id });
        at += 1;
      } else if (run.emoji) {
        // Resolve the custom emoji's image; if it's gone, keep the `:name:` text.
        const found = emojiById.get(run.emoji.id);
        if (found) {
          text.insertEmbed(at, { type: "emoji", id: run.emoji.id, name: found.name, url: found.url });
          at += 1;
        } else {
          insertPlain(`:${run.emoji.name}:`);
        }
      } else if (run.text) {
        // Split out unicode emoji so they re-load as the same atoms as picked
        // ones (enlarged), not small inline text.
        const attrs = fullAttributes(run.marks ?? {});
        for (const seg of splitEmoji(run.text)) {
          if ("text" in seg) {
            text.insert(at, seg.text, attrs);
            at += seg.text.length;
          } else {
            text.insertEmbed(at, { type: "uemoji", char: seg.emoji });
            at += 1;
          }
        }
      }
    }
  }
  if (blocks.length === 0) blocks.push([createBlock("paragraph")]);
  return doc;
}

// Expand `:name:` shorthand into custom-emoji links on send, so typed *or pasted*
// shorthand renders as the emoji. Existing markdown links are masked first so a
// `[:name:](emoji:id)` (e.g. from the picker/autocomplete) isn't double-wrapped.
function expandShortcodes(markdown: string, byName: Map<string, string>): string {
  if (byName.size === 0) return markdown;
  // The negative lookbehind skips the `:name:` inside an existing
  // `[:name:](emoji:id)` link (its opening colon sits right after `[`), so
  // picker/autocomplete atoms and re-sent messages aren't double-wrapped.
  return markdown.replace(/(?<!\[):([a-z0-9_]{2,32}):/gi, (m, name) => {
    const lower = String(name).toLowerCase();
    const id = byName.get(lower);
    return id ? `[:${lower}:](emoji:${id})` : m;
  });
}

// Message media is hard-capped at 5 MB/file (matches the upload route) and 4
// files/message (a small gallery).
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

type Pending = {
  id: string;
  kind: "image" | "video";
  previewUrl: string; // local objectURL, shown until (and after) upload
  w: number;
  h: number;
  name: string;
  size: number;
  url: string | null; // the uploaded URL once ready
  status: "uploading" | "done" | "error";
};

/** Read a picked file's dimensions + make a local preview URL, before upload. */
function readMedia(file: File): Promise<{ kind: "image" | "video"; w: number; h: number; previewUrl: string }> {
  const previewUrl = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    if (file.type.startsWith("image/")) {
      const img = new Image();
      img.onload = () => resolve({ kind: "image", w: img.naturalWidth, h: img.naturalHeight, previewUrl });
      img.onerror = () => reject(new Error("bad image"));
      img.src = previewUrl;
    } else {
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.onloadedmetadata = () => resolve({ kind: "video", w: vid.videoWidth, h: vid.videoHeight, previewUrl });
      vid.onerror = () => reject(new Error("bad video"));
      vid.src = previewUrl;
    }
  });
}

interface Props {
  channelId: string;
  channelName?: string;
  replyingTo: ReplyTarget | null;
  onClearReply: () => void;
  editing: EditTarget | null;
  onClearEdit: () => void;
}

// On touch devices, focusing the editor pops the on-screen keyboard. The
// composer remounts on every channel navigation (ChatPanel is keyed by id), so
// autofocusing there opens the keyboard each time. Only autofocus on
// fine-pointer (desktop) devices; touch users tap to type.
const AUTOFOCUS_COMPOSER =
  typeof window === "undefined" || !window.matchMedia?.("(pointer: coarse)").matches;

export function Composer({ channelId, channelName, replyingTo, onClearReply, editing, onClearEdit }: Props) {
  const orbit = useOrbit();
  const send = useMutation(api.messages.send);
  const editMessage = useMutation(api.messages.edit);
  const members = useQuery(api.members.list, orbit ? { orbitId: orbit.id } : { orbitId: "" }) ?? [];
  // Custom emoji from every orbit the user is in, so emoji from one server
  // render (and re-edit) anywhere.
  const customEmoji = useQuery(api.emoji.available, {}) ?? [];
  // When editing, also resolve any custom emoji the body references that aren't
  // in our own orbits (e.g. posted from another server), so editing renders the
  // image and re-saving keeps the link instead of dropping it to `:name:` text.
  const editRefKey = useMemo(() => {
    const body = editing?.body;
    if (!body) return "";
    const set = new Set<string>();
    for (const mt of body.matchAll(/\(emoji:([^)\s]+)\)/g)) set.add(mt[1]);
    return [...set].sort().join(",");
  }, [editing?.body]);
  const editEmojiArgs = useMemo(() => ({ ids: editRefKey ? editRefKey.split(",") : [] }), [editRefKey]);
  const resolvedEditEmoji = (useQuery(api.emoji.byIds, editEmojiArgs) ?? []) as { id: string; name: string; url: string }[];

  const emojiById = useMemo<EmojiMap>(() => {
    const m: EmojiMap = new Map();
    for (const e of customEmoji) m.set(e.id, { name: e.name, url: e.url });
    for (const e of resolvedEditEmoji) m.set(e.id, { name: e.name, url: e.url });
    return m;
  }, [customEmoji, resolvedEditEmoji]);
  const emojiByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of customEmoji) m.set(e.name, e.id);
    return m;
  }, [customEmoji]);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0); // bump to remount the editor with a fresh doc

  // ── Media attachments (image/video, ≤5 MB each, ≤4 per message) ────────────
  const [pending, setPending] = useState<Pending[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0); // dragenter/leave fire per child — count to avoid flicker
  const { startUpload } = useUploadThing("messageMedia", {
    onUploadError: (e) => alert(e.message || "Upload failed"),
  });
  const uploading = pending.some((p) => p.status === "uploading");
  const ready = pending.filter((p) => p.status === "done" && p.url);

  function clearPending() {
    setPending((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
  }
  function removePending(id: string) {
    setPending((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }
  async function onFiles(files: FileList | null) {
    if (!files) return;
    const room = MAX_ATTACHMENTS - pending.length;
    if (room <= 0) return;
    for (const file of [...files].slice(0, room)) {
      if (!/^(image|video)\//.test(file.type)) {
        alert("Only images and videos can be attached.");
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        alert(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB.`);
        continue;
      }
      let meta: Awaited<ReturnType<typeof readMedia>>;
      try {
        meta = await readMedia(file);
      } catch {
        alert(`Couldn't read "${file.name}".`);
        continue;
      }
      const id = crypto.randomUUID();
      setPending((prev) => [
        ...prev,
        { id, kind: meta.kind, previewUrl: meta.previewUrl, w: meta.w, h: meta.h, name: file.name, size: file.size, url: null, status: "uploading" },
      ]);
      startUpload([file])
        .then((res) => {
          const url = res?.[0]?.serverData?.url ?? res?.[0]?.ufsUrl ?? null;
          setPending((prev) => prev.map((p) => (p.id === id ? { ...p, url, status: url ? "done" : "error" } : p)));
        })
        .catch(() => setPending((prev) => prev.map((p) => (p.id === id ? { ...p, status: "error" } : p))));
    }
  }

  // Keep a stable handle to the latest onFiles for the native paste listener
  // (which is attached once and must not close over a stale `pending`).
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  // Paste images/videos straight into the composer. ori owns the contenteditable
  // and registers its own native paste listener, so we intercept on the capture
  // phase (which runs before it) and only when the clipboard carries media —
  // plain text / markdown paste still falls through to the editor untouched.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || editing) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files?.length && [...files].some((f) => /^(image|video)\//.test(f.type))) {
        e.preventDefault();
        e.stopPropagation();
        void onFilesRef.current(files);
      }
    };
    el.addEventListener("paste", onPaste, true);
    return () => el.removeEventListener("paste", onPaste, true);
  }, [editing]);

  // Drag-and-drop images/videos onto the composer. The browser would otherwise
  // drop a file into the contenteditable as an <img>; preventDefault stops that.
  const dragHasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  function onDragEnter(e: React.DragEvent) {
    if (editing || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (editing || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    if (editing || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void onFiles(e.dataTransfer.files);
  }

  useEffect(() => {
    if (editing) setNonce((n) => n + 1);
  }, [editing]);

  function cancelEdit() {
    onClearEdit();
    setNonce((n) => n + 1);
  }

  async function submit(markdown: string) {
    const body = expandShortcodes(markdown, emojiByName).trim();
    if (busy || uploading) return;
    if (editing) {
      // Edits are text-only.
      if (!body) return;
      setBusy(true);
      try {
        await editMessage({ id: editing.id, body });
        onClearEdit();
        setNonce((n) => n + 1);
      } catch (err) {
        alert(errorMessage(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    const attachments = ready.map((p) => ({ url: p.url, kind: p.kind, w: p.w, h: p.h, name: p.name, size: p.size }));
    if (!body && attachments.length === 0) return;
    setBusy(true);
    try {
      await send({
        channelId,
        body,
        replyTo: replyingTo?.id,
        attachments: attachments.length ? JSON.stringify(attachments) : undefined,
      });
      onClearReply();
      clearPending();
      setNonce((n) => n + 1);
    } catch (err) {
      alert(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hasBanner = !!editing || !!replyingTo;
  const hasTray = !editing && pending.length > 0;

  return (
    <div
      ref={rootRef}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative shrink-0 bg-background px-2 pb-[max(0.75rem,var(--sab))]"
    >
      {editing ? (
        <div className="animate-in-fast flex items-center gap-2 rounded-t-lg border border-b-0 border-border-strong bg-raised px-3.5 py-2 text-xs text-muted-foreground">
          <Pencil className="size-3.5 shrink-0 text-primary" />
          <span className="font-medium text-foreground">Editing message</span>
          <span className="opacity-70">· escape to cancel</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto size-5 shrink-0 rounded text-muted-foreground hover:text-foreground" onClick={cancelEdit} aria-label="Cancel edit">
            <X />
          </Button>
        </div>
      ) : replyingTo ? (
        <div className="animate-in-fast flex items-center gap-2 rounded-t-lg border border-b-0 border-border-strong bg-raised px-3.5 py-2 text-xs text-muted-foreground">
          <CornerUpLeft className="size-3.5 shrink-0 text-primary" />
          <span className="shrink-0">Replying to</span>
          <span className="font-semibold text-foreground">{replyingTo.author_name}</span>
          <span className="truncate opacity-70">{bodyPreview(replyingTo.body)}</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto size-5 shrink-0 rounded text-muted-foreground hover:text-foreground" onClick={onClearReply} aria-label="Cancel reply">
            <X />
          </Button>
        </div>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void onFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {hasTray && (
        <div
          className={cn(
            "flex flex-wrap gap-2 border border-b-0 border-border-strong bg-raised px-3 py-2.5",
            hasBanner ? "" : "rounded-t-lg",
          )}
        >
          {pending.map((p) => (
            <div key={p.id} className="group/att relative size-16 overflow-hidden rounded-md border border-border-strong bg-background">
              {p.kind === "image" ? (
                <img src={p.previewUrl} alt={p.name} className="size-full object-cover" />
              ) : (
                <>
                  <video src={p.previewUrl} className="size-full object-cover" muted playsInline />
                  <span className="pointer-events-none absolute inset-0 grid place-items-center">
                    <Play className="size-5 fill-white/90 text-white/90 drop-shadow" />
                  </span>
                </>
              )}
              {p.status === "uploading" && (
                <span className="absolute inset-0 grid place-items-center bg-black/55">
                  <Loader2 className="size-4 animate-spin text-white" />
                </span>
              )}
              {p.status === "error" && (
                <span className="absolute inset-0 grid place-items-center bg-destructive/70 text-[10px] font-medium text-white">
                  failed
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                onClick={() => removePending(p.id)}
                className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-black group-hover/att:opacity-100"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <OriInput
        key={`${editing?.id ?? "new"}-${nonce}`}
        initial={editing?.body ?? ""}
        members={members}
        orbitId={orbit?.id ?? ""}
        emojiById={emojiById}
        busy={busy}
        uploading={uploading}
        extraCanSend={ready.length > 0}
        onAttach={editing || pending.length >= MAX_ATTACHMENTS ? undefined : () => fileRef.current?.click()}
        placeholder={editing ? "Edit your message…" : channelName ? `Message #${channelName}` : "Message…"}
        roundedTop={!hasBanner && !hasTray}
        onSubmit={submit}
        onEscape={editing ? cancelEdit : replyingTo ? onClearReply : undefined}
      />

      {dragging && (
        <div className="pointer-events-none absolute inset-x-2 top-0 bottom-[max(0.75rem,var(--sab))] z-50 grid place-items-center rounded-xl border-2 border-dashed border-primary/55 bg-primary/10 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 rounded-lg bg-background/85 px-3 py-1.5 text-[13px] font-medium text-foreground shadow-sm">
            <ImagePlus className="size-4 text-primary" />
            Drop photos or videos to attach
          </div>
        </div>
      )}
    </div>
  );
}

const MARKS = [
  { mark: "bold" as const, icon: Bold, label: "Bold" },
  { mark: "italic" as const, icon: Italic, label: "Italic" },
  { mark: "strike" as const, icon: Strikethrough, label: "Strikethrough" },
  { mark: "code" as const, icon: Code, label: "Code" },
];

// The editor itself, isolated so the composer's per-keystroke re-renders (height,
// @mention / :emoji detection, active marks, send-button state) never reconcile
// <NoteEditor>. Re-rendering it on every edit reset the contentEditable selection
// on iOS — the caret went stale and you had to tap right after a mention/emoji to
// delete it. ori's own demos host <NoteEditor> in a component that doesn't
// subscribe to the editor snapshot, for exactly this reason; we mirror that with
// memo + stable props (the dynamic height lives on the wrapper, not here).
const ComposerEditor = memo(function ComposerEditor({
  editor,
  editorRef,
  placeholder,
}: {
  editor: ReturnType<typeof useEditor>;
  editorRef: React.Ref<NoteEditorHandle>;
  placeholder: string;
}) {
  return (
    <NoteEditor
      ref={editorRef}
      editor={editor}
      autoFocus={AUTOFOCUS_COMPOSER}
      placeholder={placeholder}
      maxWidth={4000}
      atomRenderers={atomRenderers}
      className="ori-chat size-full"
    />
  );
});

function OriInput({
  initial,
  members,
  orbitId,
  emojiById,
  busy,
  uploading,
  extraCanSend,
  onAttach,
  placeholder,
  roundedTop,
  onSubmit,
  onEscape,
}: {
  initial: string;
  members: Member[];
  orbitId: string;
  emojiById: EmojiMap;
  busy: boolean;
  uploading: boolean;
  // Attachments alone (no text) are enough to send.
  extraCanSend: boolean;
  // Opens the file picker; omitted (hidden) while editing or at the file cap.
  onAttach?: () => void;
  placeholder: string;
  roundedTop: boolean;
  onSubmit: (markdown: string) => void;
  onEscape?: () => void;
}) {
  // Rebuild only when editing a different body. For a new message (initial = "")
  // the emoji map is irrelevant, so we never remount on emoji-list churn — that
  // would wipe whatever the user is typing.
  const doc = useMemo(
    () => (initial ? bodyToDoc(initial, emojiById) : createNoteDoc()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initial, initial ? emojiById : null],
  );
  const editor = useEditor({ doc, schema: ORI_SCHEMA, typography: ORI_TYPO, blockSpacing: 0 });
  const snap = useEditorSnapshot(editor);
  const marks = useActiveMarks(editor);
  const editorRef = useRef<NoteEditorHandle>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fmtRef = useRef<HTMLDivElement>(null);
  const [fmtLeft, setFmtLeft] = useState<number | null>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pick, setPick] = useState(0);

  function onEmojiPick(p: EmojiPick) {
    if (p.type === "unicode") editor.insertInlineAtom({ type: "uemoji", char: p.char });
    else editor.insertInlineAtom({ type: "emoji", id: p.id, name: p.name, url: p.url });
    editorRef.current?.focus();
  }

  const height = Math.min(Math.max(Math.ceil(snap.totalHeight) || 22, 22), 168);

  // ── @mention detection ────────────────────────────────────────────────────
  const mention = useMemo(() => {
    const sel = editor.getSelection();
    if (!sel || !isCollapsed(sel)) return null;
    const before = editor.getBlockText(sel.focus.blockId).slice(0, sel.focus.offset);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    return { blockId: sel.focus.blockId, query: m[1], atOffset: sel.focus.offset - m[1].length - 1, caretOffset: sel.focus.offset };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.revision, editor]);

  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members.filter((u) => u.name.toLowerCase().includes(q) || (u.username ?? "").toLowerCase().includes(q)).slice(0, 6);
  }, [mention, members]);
  const showMentions = !!mention && matches.length > 0;
  useEffect(() => setPick(0), [mention?.query]);

  // ── `:emoji` autocomplete (mirrors @mentions) ──────────────────────────────
  const emojiList = useMemo(
    () => [...emojiById].map(([id, v]) => ({ id, name: v.name, url: v.url })),
    [emojiById],
  );
  const emojiTrigger = useMemo(() => {
    const sel = editor.getSelection();
    if (!sel || !isCollapsed(sel)) return null;
    const before = editor.getBlockText(sel.focus.blockId).slice(0, sel.focus.offset);
    // `:` must start a word (whitespace/line-start before it) so times like
    // "3:30" and URLs like "https:" don't trigger it.
    const m = before.match(/(?:^|\s):([a-z0-9_]{1,32})$/i);
    if (!m) return null;
    return { blockId: sel.focus.blockId, query: m[1].toLowerCase(), atOffset: sel.focus.offset - m[1].length - 1, caretOffset: sel.focus.offset };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.revision, editor]);

  type EmojiMatch =
    | { kind: "custom"; id: string; name: string; url: string }
    | { kind: "unicode"; char: string; name: string };
  const emojiMatches = useMemo<EmojiMatch[]>(() => {
    if (!emojiTrigger) return [];
    const q = emojiTrigger.query;
    const custom: EmojiMatch[] = emojiList
      .filter((e) => e.name.includes(q))
      .slice(0, 6)
      .map((e) => ({ kind: "custom", id: e.id, name: e.name, url: e.url }));
    const uni: EmojiMatch[] = searchEmoji(q, 12)
      .slice(0, Math.max(0, 9 - custom.length))
      .map((e) => ({ kind: "unicode", char: e.char, name: e.keywords.split(" ")[0] }));
    return [...custom, ...uni];
  }, [emojiTrigger, emojiList]);
  const showEmoji = !!emojiTrigger && emojiMatches.length > 0;
  useEffect(() => setPick(0), [emojiTrigger?.query]);

  function applyEmoji(item: EmojiMatch) {
    if (!emojiTrigger) return;
    editor.setSelection({ anchor: { blockId: emojiTrigger.blockId, offset: emojiTrigger.atOffset }, focus: { blockId: emojiTrigger.blockId, offset: emojiTrigger.caretOffset } });
    editor.deleteBackward();
    if (item.kind === "custom") editor.insertInlineAtom({ type: "emoji", id: item.id, name: item.name, url: item.url });
    else editor.insertInlineAtom({ type: "uemoji", char: item.char });
    editor.insertText(" ");
    editorRef.current?.focus();
  }

  function applyMention(u: Member) {
    if (!mention) return;
    editor.setSelection({ anchor: { blockId: mention.blockId, offset: mention.atOffset }, focus: { blockId: mention.blockId, offset: mention.caretOffset } });
    editor.deleteBackward();
    editor.insertInlineAtom({ type: "mention", label: u.name, id: u.userId });
    editor.insertText(" ");
    editorRef.current?.focus();
  }

  function onKeyDownCapture(e: React.KeyboardEvent) {
    // Backspace with the caret right after an inline atom (a just-typed @mention /
    // emoji): iOS Safari fires NO `beforeinput` for this — it just no-ops — and ori
    // only deletes via beforeinput, so the chip couldn't be removed (you'd have to
    // tap back in). Detect the atom (U+FFFC in the model text) before the collapsed
    // caret and delete it through the model ourselves; preventDefault stops the
    // beforeinput desktop *does* fire, so there's no double delete. Everything else
    // (ranges, select-all, plain text) is left to ori's native beforeinput path.
    if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const sel = editor.getSelection();
      if (
        sel &&
        isCollapsed(sel) &&
        sel.focus.offset > 0 &&
        editor.getBlockText(sel.focus.blockId).charCodeAt(sel.focus.offset - 1) === 0xfffc
      ) {
        e.preventDefault();
        editor.deleteBackward();
        return;
      }
    }
    if (showMentions) {
      if (e.key === "ArrowDown") return e.preventDefault(), setPick((i) => (i + 1) % matches.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setPick((i) => (i - 1 + matches.length) % matches.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), e.stopPropagation(), applyMention(matches[pick]);
    }
    if (showEmoji) {
      if (e.key === "ArrowDown") return e.preventDefault(), setPick((i) => (i + 1) % emojiMatches.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setPick((i) => (i - 1 + emojiMatches.length) % emojiMatches.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), e.stopPropagation(), applyEmoji(emojiMatches[pick]);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!busy && !uploading && (!snap.empty || extraCanSend)) onSubmit(editorToMarkdown(editor.doc));
      return;
    }
    if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      onEscape();
    }
  }

  // Floating menus are anchored to the composer (the relative wrapper below),
  // not to viewport caret/selection rects: ori's rects are visual-viewport
  // relative, which `position: fixed` (layout-viewport relative) mis-places on
  // iOS. Anchoring above the composer is robust and rides the keyboard.
  const sel = snap.selection;
  const ranged = !!sel && !isCollapsed(sel);
  const isQuote = editor.blockTypeAtSelection() === "quote";

  // Horizontally anchor the format menu over the selection (clamped inside the
  // composer) rather than the composer's centre, so on a wide composer it sits
  // by the selected text instead of drifting far to one side. We offset within
  // the relative wrapper (not `position: fixed`) so it stays put on iOS, where
  // ori's selection rects are visual-viewport relative. Vertical stays above the
  // composer (rides the keyboard). Runs pre-paint, so there's no reposition flash.
  useLayoutEffect(() => {
    if (!ranged) return;
    const place = () => {
      const wrap = wrapRef.current;
      const rect = editorRef.current?.getSelectionRect();
      if (!wrap || !rect) return; // keep the last position until the rect is ready
      const wr = wrap.getBoundingClientRect();
      const half = (fmtRef.current?.offsetWidth ?? 176) / 2;
      const pad = 8;
      const center = rect.left + rect.width / 2 - wr.left;
      setFmtLeft(Math.max(half + pad, Math.min(wr.width - half - pad, center)));
    };
    place();
    // The browser selection can settle a tick after the model (e.g. Cmd+A's
    // programmatic select-all), so re-place when it changes too.
    document.addEventListener("selectionchange", place);
    return () => document.removeEventListener("selectionchange", place);
  }, [ranged, snap]);

  return (
    <div
      ref={wrapRef}
      onKeyDownCapture={onKeyDownCapture}
      className={cn(
        "relative bg-raised",
        roundedTop ? "rounded-lg border border-border-strong" : "rounded-b-lg border border-t-0 border-border-strong",
      )}
    >
      <div className="flex items-center py-2.5 pl-4 pr-[7.5rem] sm:pr-[5.5rem]">
        {/* Height lives on this wrapper (it re-renders with the snapshot); the
            memoized editor below fills it and stays untouched between keystrokes. */}
        <div className="w-full" style={{ height }}>
          <ComposerEditor editor={editor} editorRef={editorRef} placeholder={placeholder} />
        </div>
      </div>

      {/* Action cluster: attach · emoji · (mobile) send. */}
      <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5">
        {onAttach && (
          <button
            type="button"
            aria-label="Attach image or video"
            title="Attach image or video (5 MB max)"
            onClick={onAttach}
            className="grid size-9 place-items-center rounded-md text-muted-foreground transition-[background-color,color,transform] hover:bg-accent hover:text-foreground active:scale-90"
          >
            <Paperclip className="size-[18px]" />
          </button>
        )}
        <button
          ref={emojiBtnRef}
          type="button"
          aria-label="Emoji"
          aria-pressed={emojiOpen}
          onClick={() => setEmojiOpen((v) => !v)}
          className={cn(
            "grid size-9 place-items-center rounded-md text-muted-foreground transition-[background-color,color,transform] hover:bg-accent hover:text-foreground active:scale-90",
            emojiOpen && "bg-accent text-foreground",
          )}
        >
          <Smile className="size-[18px]" />
        </button>
        {/* Tap-to-send — mobile only (desktop sends on Enter). */}
        <button
          type="button"
          aria-label="Send message"
          onClick={() => onSubmit(editorToMarkdown(editor.doc))}
          disabled={(snap.empty && !extraCanSend) || busy || uploading}
          className={cn(
            "grid size-9 place-items-center rounded-md bg-primary text-primary-foreground transition-[opacity,transform] active:scale-90 sm:hidden",
            ((snap.empty && !extraCanSend) || busy || uploading) && "pointer-events-none opacity-40",
          )}
        >
          {uploading ? <Loader2 className="size-[18px] animate-spin" /> : <SendHorizontal className="size-[18px]" />}
        </button>
      </div>
      {orbitId && (
        <EmojiPicker
          open={emojiOpen}
          orbitId={orbitId}
          anchorEl={emojiBtnRef.current}
          onPick={onEmojiPick}
          onClose={() => setEmojiOpen(false)}
          closeOnPick={false}
        />
      )}

      {/* Selection format menu — floats above the composer, over the selection. */}
      {ranged && (
        <div
          ref={fmtRef}
          className="absolute bottom-full z-[70] mb-2 -translate-x-1/2"
          style={{ left: fmtLeft == null ? "50%" : fmtLeft }}
        >
          <div data-ori-overlay data-anim="menu" data-state="open" style={{ transformOrigin: "bottom center" }} className="menu-surface flex items-center gap-0.5 p-1">
            {MARKS.map(({ mark, icon: Icon, label }) => (
              <button key={mark} type="button" aria-label={label} aria-pressed={!!marks[mark]} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.toggleMark(mark)} className={cn("grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground", marks[mark] && "bg-white/[0.08] text-foreground")}>
                <Icon className="size-3.5" />
              </button>
            ))}
            <span className="mx-0.5 h-5 w-px bg-border-strong" />
            <button type="button" aria-label="Quote" aria-pressed={isQuote} onMouseDown={(e) => e.preventDefault()} onClick={() => { editor.setBlockTypeAtSelection((isQuote ? "paragraph" : "quote") as BlockType); editorRef.current?.focus(); }} className={cn("grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground", isQuote && "bg-white/[0.08] text-foreground")}>
              <Quote className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* @mention autocomplete — floats above the composer (left-aligned).
          preventDefault is MOUSE-ONLY: it keeps the editor focused/selected while
          you click a row on desktop, but on touch preventing the synthesized
          mousedown leaves the contentEditable's focus/selection stale on iOS — so
          a Backspace right after picking a mention misses it until you tap again.
          applyMention re-selects + re-focuses, so touch needs no preventDefault. */}
      {showMentions && (
        <div data-ori-overlay data-anim="menu" data-state="open" style={{ transformOrigin: "bottom left" }} className="menu-surface no-scrollbar absolute bottom-full left-2 z-[70] mb-2 max-h-[220px] w-[240px] overflow-auto p-1" onPointerDown={(e) => { if (e.pointerType === "mouse") e.preventDefault(); }}>
          {matches.map((u, i) => (
            <button key={u.userId} type="button" onMouseEnter={() => setPick(i)} onClick={() => applyMention(u)} className={cn("flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left", i === pick ? "bg-white/[0.06]" : "hover:bg-white/[0.04]")}>
              <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-full">
                {u.image ? (
                  <img src={u.image} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <span className="grid size-full place-items-center text-[10px] font-semibold text-white/95" style={{ background: userColor(u.accent, u.name) }}>
                    {initials(u.name)}
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{u.name}</span>
              {u.username && <span className="shrink-0 text-[11.5px] text-muted-foreground">@{u.username}</span>}
            </button>
          ))}
        </div>
      )}

      {/* :emoji autocomplete — floats above the composer (left-aligned). */}
      {showEmoji && (
        <div data-ori-overlay data-anim="menu" data-state="open" style={{ transformOrigin: "bottom left" }} className="menu-surface no-scrollbar absolute bottom-full left-2 z-[70] mb-2 max-h-[240px] w-[260px] overflow-auto p-1" onPointerDown={(e) => { if (e.pointerType === "mouse") e.preventDefault(); }}>
          {emojiMatches.map((it, i) => (
            <button
              key={it.kind === "custom" ? `c-${it.id}` : `u-${it.char}`}
              type="button"
              onMouseEnter={() => setPick(i)}
              onClick={() => applyEmoji(it)}
              className={cn("flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left", i === pick ? "bg-white/[0.06]" : "hover:bg-white/[0.04]")}
            >
              <span className="grid size-6 shrink-0 place-items-center">
                {it.kind === "custom" ? (
                  <img src={it.url} alt="" className="size-[22px] object-contain" referrerPolicy="no-referrer" />
                ) : (
                  <span className="text-[20px] leading-none">{it.char}</span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">:{it.name}:</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
