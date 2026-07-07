import { useRef, useState, type ReactNode } from "react";

import { useUploadThing } from "@/lib/uploadthing";
import { ImageCropModal } from "./ImageCropModal";

// Reject oversized source files before we even read them into memory. The crop
// step then downscales the result, so what actually uploads is far smaller.
const MAX_INPUT_BYTES = 12 * 1024 * 1024; // 12 MB

/** A headless image picker with a built-in crop step: pick → crop (to `aspect`)
 *  → upload, then `onUploaded(url)` fires. The caller persists the URL. */
export function ImageUpload({
  onUploaded,
  onError,
  aspect = 1,
  cropShape = "rect",
  maxOutput = 1024,
  title,
  children,
}: {
  onUploaded: (url: string) => void | Promise<void>;
  onError?: (message: string) => void;
  aspect?: number;
  cropShape?: "rect" | "round";
  maxOutput?: number;
  title?: string;
  children: (state: { uploading: boolean; open: () => void }) => ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const fail = (m: string) => (onError ? onError(m) : alert(m));

  const { startUpload, isUploading } = useUploadThing("image", {
    onClientUploadComplete: async (res) => {
      const first = res?.[0];
      const url = first?.serverData?.url ?? first?.ufsUrl;
      if (url) await onUploaded(url);
    },
    onUploadError: (e) => fail(e.message || "Upload failed"),
  });

  function pick(file: File) {
    if (!file.type.startsWith("image/")) {
      fail("Please choose an image file.");
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      fail("That image is too large — please pick one under 12 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPending(reader.result as string);
    reader.onerror = () => fail("Could not read that file.");
    reader.readAsDataURL(file);
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) pick(file);
        }}
      />
      {children({ uploading: isUploading, open: () => inputRef.current?.click() })}
      {pending && (
        <ImageCropModal
          src={pending}
          aspect={aspect}
          cropShape={cropShape}
          maxOutput={maxOutput}
          title={title}
          onCancel={() => setPending(null)}
          onConfirm={async (file) => {
            setPending(null);
            await startUpload([file]);
          }}
        />
      )}
    </>
  );
}
