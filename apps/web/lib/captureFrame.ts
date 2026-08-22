import type { NormalizedRect } from "./cv/types";

export type CaptureFrameOptions = {
  maxWidth?: number;
  quality?: number;
  format?: "image/jpeg" | "image/webp";
};

const SUPPORTED_UPLOAD_TYPES = new Set(["image/jpeg", "image/webp"]);

function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: "image/jpeg" | "image/webp",
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, format, quality));
}

export type PixelCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function normalisedRectToPixels(
  sourceWidth: number,
  sourceHeight: number,
  rect: NormalizedRect,
): PixelCrop | null {
  if (
    !Number.isFinite(sourceWidth)
    || !Number.isFinite(sourceHeight)
    || sourceWidth < 1
    || sourceHeight < 1
    || !Number.isFinite(rect.x)
    || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ) return null;

  const x = Math.max(0, Math.min(sourceWidth - 1, Math.floor(rect.x * sourceWidth)));
  const y = Math.max(0, Math.min(sourceHeight - 1, Math.floor(rect.y * sourceHeight)));
  const right = Math.max(
    x + 1,
    Math.min(sourceWidth, Math.ceil((rect.x + rect.width) * sourceWidth)),
  );
  const bottom = Math.max(
    y + 1,
    Math.min(sourceHeight, Math.ceil((rect.y + rect.height) * sourceHeight)),
  );
  return { x, y, width: right - x, height: bottom - y };
}

export async function captureCurrentVideoCrop(
  video: HTMLVideoElement,
  cropBox: NormalizedRect,
): Promise<ImageBitmap | null> {
  if (
    typeof createImageBitmap !== "function"
    || video.readyState < 2
  ) return null;

  const crop = normalisedRectToPixels(video.videoWidth, video.videoHeight, cropBox);
  if (!crop) return null;
  try {
    return await createImageBitmap(
      video,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
    );
  } catch {
    return null;
  }
}

export async function encodeImageBitmap(
  image: ImageBitmap,
  options: CaptureFrameOptions = {},
): Promise<Blob | null> {
  const { maxWidth = 640, quality = 0.82, format = "image/webp" } = options;
  const scale = Math.min(1, maxWidth / image.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const encoded = await canvasToBlob(canvas, format, quality);
  if (encoded && SUPPORTED_UPLOAD_TYPES.has(encoded.type.toLowerCase())) return encoded;
  if (format === "image/webp") {
    const jpeg = await canvasToBlob(canvas, "image/jpeg", quality);
    if (jpeg && jpeg.type.toLowerCase() === "image/jpeg") return jpeg;
  }
  return null;
}

export async function encodeAndCloseImageBitmap(
  image: ImageBitmap,
  options: CaptureFrameOptions = {},
): Promise<Blob | null> {
  try {
    return await encodeImageBitmap(image, options);
  } finally {
    image.close();
  }
}
