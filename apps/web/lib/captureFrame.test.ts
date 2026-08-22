import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAndCloseImageBitmap } from "./captureFrame";

describe("final scoring candidate encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("scales to 640px WebP and always closes the consumed bitmap", async () => {
    const blob = new Blob(["encoded"], { type: "image/webp" });
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: (value: Blob | null) => void, type: string, quality: number) => {
        expect(type).toBe("image/webp");
        expect(quality).toBe(0.82);
        callback(blob);
      }),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    const image = { width: 1280, height: 720, close: vi.fn() } as unknown as ImageBitmap;

    const result = await encodeAndCloseImageBitmap(image, {
      maxWidth: 640,
      quality: 0.82,
      format: "image/webp",
    });

    expect(result).toBe(blob);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 640, 360);
    expect(image.close).toHaveBeenCalledOnce();
  });

  it("closes the bitmap when a canvas context is unavailable", async () => {
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => null) };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    const image = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;

    await expect(encodeAndCloseImageBitmap(image)).resolves.toBeNull();
    expect(image.close).toHaveBeenCalledOnce();
  });
});
