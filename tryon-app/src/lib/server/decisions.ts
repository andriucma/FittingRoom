import "server-only";
import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { config } from "./config";

/** OpenAI Decisions API (gpt-6-luna): typed answers, ~1 s, $0.10 / 1M input tokens, output free. */

const MODEL = process.env.TRYON_DECISIONS_MODEL ?? "gpt-6-luna";
const PRICE_PER_M_INPUT = 0.1;
const client = () => new OpenAI({ apiKey: config.openaiKey, maxRetries: 3, timeout: 60_000 });

type Choice = { value: string; description: string };
type Part = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type Question =
  | { type: "choice"; name: string; instructions: string | Part[]; choices: Choice[] }
  | { type: "predicate"; name: string; instructions: string | Part[] };
type Answer = { name: string; type: string; choice?: string; confidence?: number; probability?: number };

async function decide(input: unknown, questions: Question[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = await client().decisions.create({ model: MODEL, input, questions } as any, { signal });
  const answers = Object.fromEntries((d.answers as Answer[]).map((a) => [a.name, a]));
  const costUsd = ((d.usage?.input_tokens ?? 0) * PRICE_PER_M_INPUT) / 1e6;
  return { answers, costUsd };
}

export const DEPARTMENTS: Choice[] = [
  { value: "mens", description: "Sold in the men's department / menswear" },
  { value: "womens", description: "Sold in the women's department / womenswear" },
  { value: "unisex", description: "Explicitly unisex or sold for anyone" },
  { value: "kids", description: "Children's clothing" },
];

export const CATEGORIES: Choice[] = [
  { value: "top", description: "T-shirts, shirts, tank tops, polos, hoodies, sweatshirts, sweaters, sports bras, crop tops" },
  { value: "bottom", description: "Pants, joggers, jeans, shorts, leggings, skirts" },
  { value: "dress", description: "Dresses, jumpsuits, rompers, bodysuits and other one-piece outfits" },
  { value: "outerwear", description: "Jackets, coats, vests, track tops, zip-up layers worn over a top" },
  { value: "swimwear", description: "Swimsuits, bikinis, swim trunks" },
  { value: "footwear", description: "Shoes, sneakers, slides, socks" },
  { value: "accessory", description: "Bags, hats, belts, jewelry, bottles, equipment, gift cards" },
  { value: "other", description: "Underwear, sets/bundles, or anything else" },
];

const COLORS = ["black", "white", "grey", "beige", "brown", "red", "pink", "orange", "yellow", "green", "blue", "navy", "purple", "multicolor"]
  .map((c) => ({ value: c, description: c === "multicolor" ? "Several prominent colors or an all-over pattern" : `Mostly ${c}` }));

const FITS: Choice[] = [
  { value: "oversized", description: "Oversized, boxy, baggy or wide-leg" },
  { value: "regular", description: "Regular / standard fit" },
  { value: "slim", description: "Slim, fitted, tight, compression or seamless" },
  { value: "na", description: "Not a garment, or fit can't be judged" },
];

const VIEW_CHOICES: Choice[] = [
  { value: "front", description: "The garment's front faces the camera" },
  { value: "back", description: "The garment's back faces the camera" },
  { value: "side", description: "The garment is seen in profile, from the side" },
  { value: "detail", description: "A close-up of fabric, a print, a logo, a label or a pocket" },
  { value: "other", description: "The garment isn't the subject (lifestyle scene, other product, packaging)" },
];

export type ProductTags = {
  department: string; departmentConf: number;
  category: string; categoryConf: number;
  tryonProb: number;
  color: string; fit: string;
  views: { view: string; confidence: number; clean: number }[];
  costUsd: number;
};

/** Tag one product in a single Decisions request: shared JSON + first image, one view question per photo. */
export async function tagProduct(p: {
  title: string; productType: string; vendor: string; tags: string[]; description: string; imageUrls: string[];
}): Promise<ProductTags> {
  const thumbs = p.imageUrls.map((u) => `${u.split("?")[0]}?width=512`);
  const input = [{
    role: "user",
    content: [
      { type: "input_text", text: "A product listing from an online clothing store, with its main photo." },
      { type: "input_json", data: { title: p.title, product_type: p.productType, vendor: p.vendor, tags: p.tags.slice(0, 30), description: p.description.slice(0, 800) } },
      ...(thumbs[0] ? [{ type: "input_image", image_url: thumbs[0] }] : []),
    ],
  }];
  const questions: Question[] = [
    { type: "choice", name: "department", instructions: "Which store department is this product sold in? Use the listing's wording (e.g. Mens/Womens in the product type or tags) before the photo.", choices: DEPARTMENTS },
    { type: "choice", name: "category", instructions: "What kind of product is this?", choices: CATEGORIES },
    { type: "predicate", name: "tryon", instructions: "Is this a single wearable clothing garment (a top, bottom, dress or outer layer) that could be shown on a person in a full-body photo? Bundles, multipacks, socks, shoes, accessories and equipment are not." },
    { type: "choice", name: "color", instructions: "What is the garment's main color?", choices: COLORS },
    { type: "choice", name: "fit", instructions: "How is the garment cut or fitted?", choices: FITS },
    ...thumbs.flatMap((u, i): Question[] => [
      {
        type: "choice", name: `view_${i}`, choices: VIEW_CHOICES,
        instructions: [{ type: "input_text", text: "Which side of the garment does this product photo show? Judge by the garment, not the model's face." }, { type: "input_image", image_url: u }],
      },
      {
        type: "predicate", name: `clean_${i}`,
        instructions: [{ type: "input_text", text: "Is this a clean product shot: the whole garment visible, not cropped or covered, on a plain evenly lit studio backdrop (not a dark, moody or lifestyle scene)?" }, { type: "input_image", image_url: u }],
      },
    ]),
  ];
  const { answers: a, costUsd } = await decide(input, questions);
  const ch = (n: string, fallback: string) => ({ v: a[n]?.choice ?? fallback, c: a[n]?.confidence ?? 0 });
  const dep = ch("department", "unisex");
  const cat = ch("category", "other");
  return {
    department: dep.v, departmentConf: dep.c,
    category: cat.v, categoryConf: cat.c,
    tryonProb: a.tryon?.probability ?? 0,
    color: ch("color", "multicolor").v,
    fit: ch("fit", "na").v,
    views: thumbs.map((_, i) => ({ view: a[`view_${i}`]?.choice ?? "other", confidence: a[`view_${i}`]?.confidence ?? 0, clean: a[`clean_${i}`]?.probability ?? 0 })),
    costUsd,
  };
}

export type ShopperDepartment = { department: "mens" | "womens" | "all"; confidence: number; costUsd: number };

/**
 * Default clothing department to show for a shopper, from the front (0°) frame of their recording.
 * This only picks which catalog section to show first; it is shown to the user and always overridable.
 * Low confidence falls back to showing everything.
 */
export async function shopperDepartment(frame: string, minConfidence = 0.8, signal?: AbortSignal): Promise<ShopperDepartment> {
  signal?.throwIfAborted();
  const b64 = (await readFile(frame)).toString("base64");
  const { answers, costUsd } = await decide(
    [{ role: "user", content: [
      { type: "input_text", text: "A shopper's full-body photo, taken to try clothes on virtually." },
      { type: "input_image", image_url: `data:image/jpeg;base64,${b64}` },
    ] }],
    [{
      type: "choice", name: "department",
      instructions: "Which clothing department's sizes and cuts would most likely fit this shopper's body by default: men's or women's? Choose 'either' if it is unclear.",
      choices: [
        { value: "mens", description: "Men's department" },
        { value: "womens", description: "Women's department" },
        { value: "either", description: "Unclear; show both departments" },
      ],
    }],
    signal,
  );
  const a = answers.department;
  const choice = a?.choice === "mens" || a?.choice === "womens" ? a.choice : "all";
  const confidence = a?.confidence ?? 0;
  return { department: choice !== "all" && confidence >= minConfidence ? choice : "all", confidence, costUsd };
}
