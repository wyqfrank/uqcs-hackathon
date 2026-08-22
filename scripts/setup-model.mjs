import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const checkpointUrl = process.env.FITTED_GARMENT_CHECKPOINT_URL
  || "https://github.com/wyqfrank/uqcs-hackathon/releases/download/fashionpedia-rfdetr-f1b64c11/checkpoint_best_ema.pth";
const configuredPath = process.env.FITTED_GARMENT_CHECKPOINT_PATH
  || "models/rfdetr-fashionpedia/checkpoint_best_ema.pth";
const checkpointPath = isAbsolute(configuredPath)
  ? configuredPath
  : resolve(repositoryRoot, configuredPath);
const expectedBytes = 134442577;
const expectedSha256 = "aafefc440ea8f3f388e894a898e4270a2eeb6e38a3c3ffd3751d07d0f30b26bb";
const force = process.argv.includes("--force");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verify(path) {
  const file = await stat(path);
  const digest = await sha256(path);
  return {
    valid: file.size === expectedBytes && digest === expectedSha256,
    bytes: file.size,
    digest,
  };
}

async function main() {
  if (await exists(checkpointPath)) {
    const current = await verify(checkpointPath);
    if (current.valid) {
      console.log(`RF-DETR checkpoint already verified: ${checkpointPath}`);
      return;
    }
    if (!force) {
      throw new Error(
        `Checkpoint verification failed at ${checkpointPath}. `
        + `Found ${current.bytes} bytes with SHA-256 ${current.digest}. `
        + "Run npm run setup:model -- --force to replace it.",
      );
    }
  }

  await mkdir(dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.${randomUUID()}.download`;
  try {
    console.log(`Downloading pinned RF-DETR checkpoint from ${checkpointUrl}`);
    const response = await fetch(checkpointUrl, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Checkpoint download failed with HTTP ${response.status}.`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporaryPath, { flags: "wx" }),
    );

    const downloaded = await verify(temporaryPath);
    if (!downloaded.valid) {
      throw new Error(
        `Downloaded checkpoint verification failed. Found ${downloaded.bytes} bytes `
        + `with SHA-256 ${downloaded.digest}.`,
      );
    }
    if (force) await rm(checkpointPath, { force: true });
    await rename(temporaryPath, checkpointPath);
    console.log(`RF-DETR checkpoint downloaded and verified: ${checkpointPath}`);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
