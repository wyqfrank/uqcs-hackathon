export function normaliseImageMimeType(value) {
  const mimeType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

export function imageFilename(stem, mimeType) {
  const extension = mimeType === "image/jpeg"
    ? "jpg"
    : mimeType === "image/png" ? "png" : "webp";
  return `${stem}.${extension}`;
}
