import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { config, pricing } from "./config";
import { assertOmniDuration } from "./ffmpeg";

/** Gemini Omni video edit: re-dress the ORIGINAL video using try-on frames as references. */

const KEEP = (top: string, bottom: string) =>
  `Replace the original upper-body garment with exactly the selected ${top}, and the original lower-body garment with exactly the selected ${bottom}. Do not stack the new outfit over the old outfit, add duplicate layers, or copy companion clothing from the references. Everything outside those two clothing slots stays exactly as in the video in every frame: whatever is on their feet, their watch and other accessories. Do not take shoes, socks or accessories from the reference images, and do not invent, add or remove those items.`;

export function omniPrompt(opts: { top: string; bottom: string; studio: boolean }) {
  const { top, bottom, studio } = opts;
  const refs = studio
    ? "The first four reference images show the same person wearing the target outfit in a photo studio, seen from the front, one side, the back and the other side. The last reference image is that empty studio. The reference images show only what the outfit looks like; they are not poses, keyframes or stopping points."
    : "The reference images show the same person wearing the target outfit, seen from the front, one side, the back and the other side. They show only what the outfit looks like; they are not poses, keyframes or stopping points.";
  // The model otherwise under-rotates and parks on the last reference pose (the back) instead of
  // tracking the input video, so the motion is pinned to the source explicitly and forcefully.
  const motion = "Match the body's rotation to the input video exactly: at every moment the person must face the same direction as in the input video, turning at the same speed, and the clip must end with the person facing the camera again after one complete 360° turn — the same full turn as the input video. Keep turning smoothly and continuously from the first frame to the last. Never pause, stop, hold a pose, slow down, speed up or reverse, and never stop turning when the body happens to line up with a reference image. The person must not still be mid-turn or facing away when the clip ends.";
  const outfit = `Replace only the clothing, in every frame, with exactly the ${top} and ${bottom} in the reference images. Any print on the back must match the back reference exactly and be visible only while the back faces the camera; anything printed on the front is visible only while the front faces the camera. The garments must turn with the body naturally and look the same throughout the turn.`;
  const scene = studio
    ? "Replace the entire room (walls, doors, furniture, lamps, floor, cables and every object) with the empty studio from the last reference image: the same backdrop, floor and soft even studio lighting, with a soft shadow under the feet. Nothing from the room may remain. Relight the person to match the studio.\n\n"
    : "";
  const keepScene = studio
    ? "Keep exactly as in the video: the face, hair, body, hands, the person's position and size in the frame, and the camera."
    : "Keep everything else exactly as in the video: the face, hair, body, hands, the room, the lighting and the camera.";
  return `Edit this video. It shows a person slowly turning a full circle in place. ${refs}

${motion}

${outfit}

${scene}${KEEP(top, bottom)}

${keepScene} Do not add objects, text, music or camera movement.`;
}

export async function omniEdit(opts: {
  video: string; seconds: number; refs: string[]; prompt: string; out: string; resolution: "360p" | "720p" | "1080p";
}): Promise<{ seconds: number; costUsd: number; outputTokens: number }> {
  if (!config.geminiKey) throw new Error("GEMINI_API_KEY is not set");
  await assertOmniDuration(opts.video, opts.seconds);
  // Omni lives on the v1beta Interactions API (the JS SDK defaults to v1 and rejects text inputs there).
  const ai = new GoogleGenAI({ apiKey: config.geminiKey, apiVersion: "v1beta" });
  const t0 = Date.now();
  let file = await ai.files.upload({ file: opts.video, config: { mimeType: "video/mp4" } });
  while (file.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name: file.name! });
  }
  if (file.state !== "ACTIVE") throw new Error(`video upload failed: ${file.state}`);

  const images = await Promise.all(opts.refs.map(async (f) => ({
    type: "image" as const, data: (await readFile(f)).toString("base64"), mime_type: f.endsWith(".png") ? "image/png" : "image/jpeg",
  })));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interaction: any = await ai.interactions.create({
    model: config.models.omni,
    input: [{ type: "video", uri: file.uri! }, ...images, { type: "text", text: opts.prompt }],
    response_format: { type: "video", aspect_ratio: "9:16", resolution: opts.resolution, duration: `${opts.seconds}s`, delivery: "inline" },
    store: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const data: string | undefined = interaction.output_video?.data;
  if (!data) throw new Error("Omni returned no video");
  await writeFile(opts.out, Buffer.from(data, "base64"));
  const outputTokens: number = interaction.usage?.total_output_tokens ?? 0;
  return { seconds: (Date.now() - t0) / 1000, outputTokens, costUsd: (outputTokens * pricing.omniOutPerM) / 1e6 };
}
