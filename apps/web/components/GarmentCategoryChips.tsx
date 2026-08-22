import { GARMENT_LABELS, type GarmentCategory } from "@/lib/garmentPerception";

export function GarmentCategoryChips({
  categories,
}: {
  categories: GarmentCategory[];
}) {
  if (!categories.length) return null;
  return (
    <ul className="garment-chips" aria-label="Detected clothing categories">
      {categories.map((category) => (
        <li key={category}>{GARMENT_LABELS[category]}</li>
      ))}
    </ul>
  );
}
