/** Keep store names readable even when a Shopify feed only provides its domain. */
export function displayStoreName(name: string | null | undefined, domain: string): string {
  if (name && name !== domain) return name.split(/\s*[|–—]\s*/)[0].replace(/&amp;/g, "&").trim() || domain;
  const short = domain.replace(/^www\./, "").split(".")[0].replace(/(?:usa|us-store)$/, "").replace(/[-_]+/g, " ");
  return short.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
