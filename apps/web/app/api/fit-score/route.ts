const INFERENCE_URL = process.env.FITTED_INFERENCE_API_URL || "http://localhost:8000";

// Frames are scored one at a time as they arrive; nothing here is cacheable.
export const dynamic = "force-dynamic";

/**
 * Proxies a single frame to the inference service's live ranker.
 *
 * The browser could reach the service directly — CORS allows it in
 * development — but going through the app keeps the inference host a
 * server-side concern, so it does not have to be a public URL in production
 * and the client needs no configuration at all.
 */
export async function POST(request: Request) {
  const body = await request.formData();
  const image = body.get("image");
  if (!(image instanceof Blob)) {
    return Response.json({ error: "A frame is required." }, { status: 422 });
  }

  const upstream = new FormData();
  upstream.append("image", image, "frame.webp");

  try {
    const response = await fetch(`${INFERENCE_URL}/v1/fit-score`, {
      method: "POST",
      body: upstream,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return Response.json(
        {
          error:
            (payload && typeof payload.detail === "string" && payload.detail)
            || `Scoring failed (${response.status}).`,
        },
        { status: response.status, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "unknown error";
    return Response.json(
      { error: `Inference service is unreachable: ${message}` },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET() {
  try {
    const response = await fetch(`${INFERENCE_URL}/v1/fit-score/health`, {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    return Response.json(payload ?? { ready: false }, {
      status: response.ok ? 200 : response.status,
      headers: { "cache-control": "no-store" },
    });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "unknown error";
    return Response.json(
      { ready: false, modelVersion: "unavailable", reason: `Unreachable: ${message}` },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
