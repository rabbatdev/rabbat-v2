import { useCallback, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Loader2, ZoomIn } from "lucide-react";
import "react-easy-crop/react-easy-crop.css";

import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/util";

/** Crop + downscale `src` to the given aspect, returning a compressed File ready
 *  to upload. JPEG keeps files small; PNG sources stay PNG to preserve alpha. */
async function cropToFile(src: string, area: Area, maxOutput: number): Promise<File> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
  // Downscale if the crop is bigger than the target so uploads stay light.
  const longest = Math.max(area.width, area.height);
  const scale = longest > maxOutput ? maxOutput / longest : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(area.width * scale));
  canvas.height = Math.max(1, Math.round(area.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  const isPng = src.startsWith("data:image/png");
  const mime = isPng ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, 0.9));
  if (!blob) throw new Error("could not encode image");
  return new File([blob], isPng ? "image.png" : "image.jpg", { type: mime });
}

export function ImageCropModal({
  src,
  aspect,
  cropShape = "rect",
  maxOutput,
  title = "Crop image",
  onCancel,
  onConfirm,
}: {
  src: string;
  aspect: number;
  cropShape?: "rect" | "round";
  maxOutput: number;
  title?: string;
  onCancel: () => void;
  onConfirm: (file: File) => void | Promise<void>;
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onComplete = useCallback((_: Area, px: Area) => setArea(px), []);

  async function apply() {
    if (!area) return;
    setBusy(true);
    setError(null);
    try {
      const file = await cropToFile(src, area, maxOutput);
      await onConfirm(file);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => {} : onCancel} className="max-w-[480px] overflow-hidden p-0">
      <div className="border-b border-border-strong px-5 py-3.5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        <p className="text-[12.5px] text-muted-foreground">Drag to reposition · scroll or use the slider to zoom</p>
      </div>
      <div className="relative h-[320px] bg-black">
        <Cropper
          image={src}
          crop={crop}
          zoom={zoom}
          aspect={aspect}
          cropShape={cropShape}
          showGrid={false}
          restrictPosition
          minZoom={1}
          maxZoom={4}
          zoomSpeed={0.25}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onComplete}
        />
      </div>
      <div className="px-5 py-4">
        <div className="flex items-center gap-3">
          <ZoomIn className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom"
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-raised accent-[var(--primary)]"
          />
        </div>
        {error && <p className="mt-3 text-[12.5px] text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" className="h-9" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            className="h-9 gap-2 bg-primary text-primary-foreground hover:bg-primary-hover"
            onClick={apply}
            disabled={busy || !area}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Apply
          </Button>
        </div>
      </div>
    </Modal>
  );
}
