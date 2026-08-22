import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PreviewStage } from "./PreviewStage";

export const metadata: Metadata = { title: "FITTED — UI preview", robots: { index: false } };

/**
 * Development-only. Guarded here rather than by convention so the route cannot
 * reach a deployed build even if someone links to it.
 */
export default function PreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PreviewStage />;
}
