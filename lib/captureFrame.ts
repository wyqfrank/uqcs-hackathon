export type CaptureFrameOptions = {
  maxWidth?: number;
  quality?: number;
  format?: "image/jpeg" | "image/webp";
};

export async function captureVideoFrame(
  video: HTMLVideoElement,
  options: CaptureFrameOptions = {},
): Promise<Blob | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;

  const { maxWidth = 640, quality = 0.78, format = "image/webp" } = options;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;

  const scale = Math.min(1, maxWidth / sourceWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, format, quality));
}
