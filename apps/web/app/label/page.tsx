import type { Metadata } from "next";
import { LabelApp } from "@/components/label/LabelApp";

export const metadata: Metadata = {
  title: "FITTED — Outfit rating station",
  description: "Pairwise A/B outfit labelling for the FITTED scoring model.",
};

export default function LabelPage() {
  return <LabelApp />;
}
