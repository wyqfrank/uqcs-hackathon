export function normaliseImageMimeType(value) {
  const mimeType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

export function imageFilename(stem, mimeType) {
  return `${stem}.${mimeType === "image/jpeg" ? "jpg" : "webp"}`;
}
