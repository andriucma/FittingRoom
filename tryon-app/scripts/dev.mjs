#!/usr/bin/env node
// Dev and production start both need the local Python service. Ctrl+C stops both.
import { spawn, spawnSync } from "node:child_process";
import nextEnv from "@next/env";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = process.argv[2] === "--production";
const nextArgs = process.argv.slice(production ? 3 : 2);
nextEnv.loadEnvConfig(root, !production);
const pyDir = path.join(root, "python");
const uvicorn = path.join(pyDir, ".venv", "bin", "uvicorn");
const dataDir = process.env.TRYON_DATA_DIR ?? path.join(root, "data");
mkdirSync(dataDir, { recursive: true });

if (!existsSync(uvicorn)) {
  console.error("Python env missing. Run: npm run setup:python");
  process.exit(1);
}
for (const bin of [process.env.FFMPEG_PATH ?? "ffmpeg", process.env.FFPROBE_PATH ?? "ffprobe"]) {
  const result = spawnSync(bin, ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    console.error(`Video tool unavailable: ${bin}. Install ffmpeg before starting FittingRoom.`);
    process.exit(1);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(url, child, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`local-models exited with code ${child.exitCode}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`local-models not healthy after ${timeoutMs / 1000}s`);
}

const port = Number(process.env.LOCAL_MODELS_PORT) || (await freePort());
const url = `http://127.0.0.1:${port}`;
const env = { ...process.env, TRYON_DATA_DIR: dataDir, HF_HUB_DISABLE_XET: "1" };

const py = spawn(uvicorn, ["tryon_local.server:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"],
  { cwd: pyDir, env, stdio: ["ignore", "inherit", "inherit"] });
const children = [py];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
py.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[dev] local-models exited (${code}); stopping`);
    shutdown(code ?? 1);
  }
});

let ready = false;
try {
  await waitHealthy(url, py);
  ready = true;
} catch (e) {
  console.error(`[dev] ${e.message}`);
  shutdown(1);
}
if (ready) {
  console.log(`[app] local-models ready at ${url}`);
  const next = spawn(path.join(root, "node_modules", ".bin", "next"), [production ? "start" : "dev", ...nextArgs],
    { cwd: root, env: { ...env, LOCAL_MODELS_URL: url }, stdio: "inherit" });
  children.push(next);
  next.on("exit", (code) => shutdown(code ?? 0));
}
