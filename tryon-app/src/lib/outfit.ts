import type { ProductSummary, TryOnKind } from "./types";

type Garment = { id: number; title: string; productType: string; category: string };

/** A single top replaces the upper garment; a single bottom replaces the lower one. */
export function garmentSlot(p: Garment): TryOnKind | null {
  const text = `${p.title} ${p.productType}`.toLowerCase();
  if (/\b(jumpsuit|romper|playsuit|unitard|catsuit|overalls?|dungarees|bodysuit)\b/.test(text) || /\bdress\b(?![ -]+(?:shirts?|pants?|trousers?))/.test(text) || p.category === "dress") return "dress";
  if (/\b(two[ -]pieces?|matching sets?|co[ -]?ord sets?|tracksuits?|outfit sets?|multipack|[2-9][ -]?pack|pack of [2-9]|set of [2-9])\b/.test(text)) return null;
  if (p.category === "top" || p.category === "outerwear") return "top";
  if (p.category === "bottom") return "bottom";
  return null;
}

export function outfitError(top: Garment | null, bottom: Garment | null): string | null {
  if (!top || !bottom) return "Choose one top and one bottom from the catalog.";
  if (top.id === bottom.id) return "The same product cannot occupy two garment slots.";
  if (garmentSlot(top) !== "top") return "The upper slot needs a single top or jacket. One-piece outfits and clothing sets would overlap the bottoms.";
  if (garmentSlot(bottom) !== "bottom") return "The lower slot needs a single pair of bottoms. One-piece outfits and clothing sets would overlap the top.";
  return null;
}

/** Metadata-based styling suggestions; these are optional, never a compatibility requirement. */
export function pairingScore(candidate: ProductSummary, selected: { color: string; fit: string; storeId: number }) {
  const neutral = new Set(["black", "white", "grey", "gray", "beige", "brown", "navy"]);
  const color = candidate.color?.toLowerCase();
  const selectedColor = selected.color?.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (color && selectedColor && neutral.has(color)) { score += 5; reasons.push("A versatile neutral pairing"); }
  else if (color && color !== "multicolor" && color === selectedColor) { score += 4; reasons.push("A coordinated color palette"); }
  else if (color && color !== "multicolor" && neutral.has(selectedColor)) { score += 3; reasons.push("Adds color to your neutral piece"); }
  const complements: Record<string, string[]> = { blue: ["orange", "beige", "brown"], green: ["pink", "beige"], pink: ["green", "navy"], red: ["navy", "beige"], purple: ["yellow", "grey"], yellow: ["purple", "navy"], orange: ["blue", "navy"] };
  if (complements[selectedColor]?.includes(color)) { score += 3; reasons.push("Complementary colors"); }
  if ((selected.fit === "oversized" && candidate.fit === "slim") || (selected.fit === "slim" && candidate.fit === "oversized")) { score += 2; reasons.push("Balances fitted and relaxed shapes"); }
  if (selected.fit === candidate.fit && selected.fit !== "na") score += 1;
  if (selected.storeId === candidate.storeId) score += 0.5;
  return { score, reason: reasons[0] ?? null };
}

/** Catalog wording, rather than the other items the product model happens to wear. */
export function garmentPrompt(p: Garment): string {
  const text = `${p.title} ${p.productType}`.toLowerCase();
  const bottom = garmentSlot(p) === "bottom";
  const patterns: [RegExp, string][] = bottom ? [
    [/\b(shorts?)\b/, "shorts"], [/\b(skirt)\b/, "skirt"], [/\b(leggings?)\b/, "leggings"], [/\b(jeans?|denim)\b/, "jeans"],
  ] : [
    [/\b(sports bra|bralette)\b/, "sports bra"],
    [/\b(t[ -]?shirt|tee)\b/, "t-shirt"], [/\b(hoodie|sweatshirt)\b/, "sweatshirt"],
    [/\b(jacket|coat|blazer|puffer|parka)\b/, "jacket"], [/\b(tank|camisole)\b/, "tank top"],
    [/\b(sweater|pullover|cardigan|knit)\b/, "sweater"], [/\b(blouse|shirt|polo)\b/, "shirt"],
  ];
  for (const [pattern, noun] of patterns) if (pattern.test(text)) return noun;
  return bottom ? "pants" : "top";
}
