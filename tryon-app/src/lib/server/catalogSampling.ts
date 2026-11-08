/** Listing metadata is used only for sampling; the vision tagger sets final filters. */
export function listingDepartment(p: { product_type: string; tags: string[] | string }): string {
  const tags = Array.isArray(p.tags) ? p.tags : p.tags.split(",");
  const text = [p.product_type, ...tags].join(" ").toLowerCase();
  if (/\b(kids?|children|toddler|baby|youth|boys?|girls?)\b/.test(text)) return "kids";
  if (/\bunisex\b/.test(text)) return "unisex";
  const women = /\b(women'?s?|womenswear|female|ladies)\b/.test(text);
  const men = /\b(men'?s?|menswear|male)\b/.test(text);
  return women && !men ? "womens" : men && !women ? "mens" : "unknown";
}

/** Round-robin departments within each section, keeping in-stock items first per group. */
export function balancedSample<T extends { p: { product_type: string; tags: string[] | string; variants: { available?: boolean }[] }; section: string }>(
  items: T[], sections: readonly string[], perSection: number,
): T[] {
  return sections.flatMap((section) => {
    const groups = new Map<string, T[]>();
    for (const item of items.filter((i) => i.section === section)) {
      const department = listingDepartment(item.p);
      if (department === "kids") continue;
      const group = groups.get(department) ?? [];
      group.push(item);
      groups.set(department, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => Number(b.p.variants.some((v) => v.available)) - Number(a.p.variants.some((v) => v.available)));
    }
    const selected: T[] = [];
    const queues = [...groups.values()];
    for (let index = 0; selected.length < perSection; index++) {
      let added = false;
      for (const queue of queues) {
        if (queue[index] && selected.length < perSection) {
          selected.push(queue[index]);
          added = true;
        }
      }
      if (!added) break;
    }
    return selected;
  });
}
