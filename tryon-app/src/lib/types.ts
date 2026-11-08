/** Types shared by API routes and the UI (no server-only imports here). */

export type ProductKind = "top" | "bottom" | "other";
export type GarmentView = "front" | "back" | "side" | "detail" | "other";

export type Department = "mens" | "womens" | "all";
export type TryOnKind = "top" | "bottom" | "dress";

export type Store = {
  id: number;
  domain: string;
  apiBase: string;
  name: string;
  status: "queued" | "fetching" | "tagging" | "ready" | "error";
  totalProducts: number;
  sampled: number;
  tagged: number;
  tagCostUsd: number;
  error: string | null;
  createdAt: string;
  processing: boolean;
};

/** Product image as stored in the catalog DB; view/clean come from the Decisions API. */
export type CatalogImage = {
  src: string; width: number; height: number; position: number;
  view?: string; viewConfidence?: number; clean?: number; manual?: boolean;
};

export type CatalogProduct = {
  id: number; storeId: number; storeDomain: string; apiBase: string; handle: string; title: string; vendor: string;
  productType: string; tags: string[]; description: string; url: string; priceMin: number | null; images: CatalogImage[];
  department: string; category: string; tryonProb: number; color: string; fit: string; taggedAt: string | null;
};

export type ProductSummary = {
  id: number;
  storeId: number;
  storeName: string;
  handle: string;
  title: string;
  productType: string;
  kind: TryOnKind;
  department: string;
  category: string;
  color: string;
  fit: string;
  price: string | null;
  image: string;
  imageCount: number;
};

export type ShopperProfile = { department: Department; confidence: number; source: "auto" | "manual" };

export type ProductImage = {
  index: number;
  file: string;
  src: string;
  url: string | null;
  width: number;
  height: number;
  view: GarmentView;
  fullyVisible: boolean;
  plainBackground: boolean;
  manual?: boolean;
  clean?: number;
};

export type ImportedProduct = {
  id: number;
  storeDomain: string;
  handle: string;
  title: string;
  productType: string;
  kind: ProductKind;
  price: string | null;
  images: ProductImage[];
  importedAt: string;
};

export type VideoAsset = { id: string; file: string; url: string | null; preview: string | null; name: string; createdAt: string; check?: VideoCheck | null; profile?: ShopperProfile | null };

export type VideoCheck = {
  ok: boolean;
  rotationDeg: number;
  direction: "left" | "right";
  frames: number;
  stillLeadInFrames: number;
  issues: string[];
  seconds: number;
  contactSheet: string | null;
};

export type Background = "original" | "studio";
export type StepStatus = "pending" | "running" | "done" | "skipped" | "error";
export type StepName = "angles" | "tryon" | "framing" | "spin" | "omni";

export type RunInput = {
  videoId: string;
  top: number;      // catalog product id
  bottom: number;   // catalog product id
  background: Background;
  stepDeg: number;
  model: string;
  quality: "low" | "medium" | "high";
  omni: { enabled: boolean; resolution: "360p" | "720p" | "1080p" };
};

export type RunFrame = {
  index: number;
  angle: number;
  source: string;
  sourceUrl?: string | null;
  tryon?: string;
  tryonUrl?: string | null;
  final?: string;
  finalUrl?: string | null;
  views?: string[];
  seconds?: number;
  costUsd?: number;
  error?: string;
};

export type Run = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "done" | "error" | "interrupted";
  error?: string;
  input: RunInput;
  steps: Record<StepName, { status: StepStatus; startedAt?: string; finishedAt?: string; detail?: string; done?: number; total?: number }>;
  frames: RunFrame[];
  outputs: {
    spin?: string; spinUrl?: string | null;
    omni?: string; omniUrl?: string | null;
    omniCompare?: string; omniCompareUrl?: string | null;
    contactSheet?: string; contactSheetUrl?: string | null;
  };
  stats: { rotationDeg?: number; direction?: string; framingSpread?: Record<string, { before: number; after: number }> };
  cost: { openaiUsd: number; geminiUsd: number };
};
