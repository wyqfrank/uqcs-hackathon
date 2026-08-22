import type { GarmentCategory } from "@/lib/garmentPerception";

const LABELS: Record<GarmentCategory, string> = {
  top: "TOP",
  bottoms: "BOTTOMS",
  dress: "ONE-PIECE",
  outerwear: "OUTERWEAR",
  shoes: "SHOES",
  bag: "BAG",
  headwear: "HEADWEAR",
  accessory: "ACCESSORY",
};

export function GarmentCategoryChips({
  categories,
}: {
  categories: GarmentCategory[];
}) {
  if (!categories.length) return null;
  return (
    <ul className="garment-chips" aria-label="Detected clothing categories">
      {categories.map((category) => (
        <li key={category}>{LABELS[category]}</li>
      ))}
    </ul>
  );
}
