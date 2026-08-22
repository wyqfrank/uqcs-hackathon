export type CaptureFrameOptions = {
  maxWidth?: number;
  quality?: number;
  format?: "image/jpeg" | "image/webp";
};

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
  return new Promise((resolve) => canvas.toBlob(resolve, format, quality));
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
