import { connection } from "next/server";
import { config } from "@/lib/server/config";
import { localModels } from "@/lib/server/localModels";
import { mediaToolsHealth } from "@/lib/server/ffmpeg";

/** Which services and keys are available. */
export async function GET() {
  await connection();
  const [models, mediaTools] = await Promise.all([localModels.health(), mediaToolsHealth()]);
  return Response.json({
    localModels: { url: config.localModelsUrl, ...models },
    mediaTools,
    keys: { openai: !!config.openaiKey, gemini: !!config.geminiKey, shopifyStore: config.shopifyStore || null },
    models: config.models,
  });
}
