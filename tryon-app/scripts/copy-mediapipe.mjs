#!/usr/bin/env node
// Self-host the in-browser pose model: copy MediaPipe's WASM runtime into public/ and download the
// Pose Landmarker (lite) model once. Runs on `npm install` (postinstall) and is safe to re-run.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmOut = path.join(root, "public", "mediapipe", "wasm");
const modelOut = path.join(root, "public", "mediapipe", "pose_landmarker_lite.task");
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

mkdirSync(wasmOut, { recursive: true });
for (const f of readdirSync(src)) copyFileSync(path.join(src, f), path.join(wasmOut, f));
console.log(`[mediapipe] wasm -> ${path.relative(root, wasmOut)}`);

if (!existsSync(modelOut)) {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  writeFileSync(modelOut, Buffer.from(await res.arrayBuffer()));
  console.log(`[mediapipe] model -> ${path.relative(root, modelOut)}`);
}
