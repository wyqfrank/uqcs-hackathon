import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureCurrentVideoCrop,
  encodeAndCloseImageBitmap,
  normalisedRectToPixels,
} from "./captureFrame";

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

  it("falls back to JPEG when the browser cannot encode WebP", async () => {
    const jpeg = new Blob(["jpeg"], { type: "image/jpeg" });
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: (value: Blob | null) => void, type: string) => {
        callback(type === "image/jpeg" ? jpeg : new Blob(["png"], { type: "image/png" }));
      }),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    const image = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;

    await expect(encodeAndCloseImageBitmap(image, { format: "image/webp" })).resolves.toBe(jpeg);
    expect(canvas.toBlob).toHaveBeenNthCalledWith(1, expect.any(Function), "image/webp", 0.82);
    expect(canvas.toBlob).toHaveBeenNthCalledWith(2, expect.any(Function), "image/jpeg", 0.82);
    expect(image.close).toHaveBeenCalledOnce();
  });

  it("captures the current video image using the latest normalised outfit crop", async () => {
    const image = { width: 960, height: 864, close: vi.fn() } as unknown as ImageBitmap;
    const createBitmap = vi.fn(async () => image);
    vi.stubGlobal("createImageBitmap", createBitmap);
    const video = {
      readyState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
    } as HTMLVideoElement;

    await expect(captureCurrentVideoCrop(video, {
      x: 0.25,
      y: 0.1,
      width: 0.5,
      height: 0.8,
    })).resolves.toBe(image);
    expect(createBitmap).toHaveBeenCalledWith(video, 480, 108, 960, 864);
  });

  it("clamps crop geometry to the current video bounds", () => {
    expect(normalisedRectToPixels(100, 80, {
      x: -0.1,
      y: 0.25,
      width: 1.2,
      height: 1,
    })).toEqual({ x: 0, y: 20, width: 100, height: 60 });
  });
});
