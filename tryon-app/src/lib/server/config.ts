import "server-only";
import path from "node:path";

/** Server-side configuration from .env.local. */
export const config = {
  openaiKey: process.env.OPENAI_KEY ?? process.env.OPENAI_API_KEY ?? "",
  geminiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
  shopifyStore: (process.env.SHOPIFY_STOREFRONT_URL ?? "").replace(/\/+$/, ""),
  shopifyStores: (process.env.SHOPIFY_STORE_URLS ?? "").split(/[,\s]+/).map((url) => url.trim()).filter(Boolean),
  /** Python local-models service; scripts/dev.mjs sets this to a free port. */
  localModelsUrl: process.env.LOCAL_MODELS_URL ?? "http://127.0.0.1:8001",
  dataDir: path.resolve(/*turbopackIgnore: true*/ process.env.TRYON_DATA_DIR ?? path.join(process.cwd(), "data")),
  /** Sample spin video offered in the UI (repo root). */
  sampleVideo: path.resolve(/*turbopackIgnore: true*/ process.cwd(), "..", "IMG_8204.mov"),
  ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobe: process.env.FFPROBE_PATH ?? "ffprobe",
  models: {
    image: process.env.TRYON_IMAGE_MODEL ?? "gpt-image-2.6-flare",
    decisions: process.env.TRYON_DECISIONS_MODEL ?? "gpt-6-luna",
    omni: process.env.TRYON_OMNI_MODEL ?? "gemini-omni-flash-preview",
  },
};

/** USD per 1M tokens. */
export const pricing = {
  gptImage: { imageIn: 8, textIn: 5, out: 30 },
  omniOutPerM: 12,
};
