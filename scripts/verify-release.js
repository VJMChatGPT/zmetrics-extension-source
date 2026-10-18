import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SOURCE_ROOT, RELEASE_FILES, sha256, safeRead, validateRelease } from "./build-release.js";
import { readZip } from "./zip.js";
import { SOURCE_FILES } from "./release-files.js";
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(SOURCE_ROOT, "dist");
const metadata = JSON.parse(await readFile(resolve(root, "release.json"), "utf8"));
if (metadata.zip !== `zmetrics-${metadata.version}.zip`) throw new Error("Unexpected artifact name");
const bytes = await readFile(resolve(root, metadata.zip));
if (sha256(bytes) !== metadata.zipSha256) throw new Error("ZIP hash mismatch");
const entries = readZip(bytes);
if (JSON.stringify(entries.map(([name]) => name)) !== JSON.stringify([...RELEASE_FILES])) throw new Error("ZIP inventory mismatch");
if (JSON.stringify(Object.keys(metadata.files).sort()) !== JSON.stringify([...RELEASE_FILES])) throw new Error("Hash inventory mismatch");
const result = await validateRelease(resolve(root, "extension"));
if (result.version !== metadata.version) throw new Error("Artifact version mismatch");
for (const [name, data] of entries) {
  if (sha256(data) !== metadata.files[name] || !data.equals(await safeRead(resolve(root, "extension"), name)) || !data.equals(await safeRead(SOURCE_ROOT, name))) throw new Error(`Payload mismatch: ${name}`);
}
for (const [file, expected] of [["FILES.sha256", Object.entries(metadata.files).map(([name, hash]) => `${hash}  ${name}`).join("\n") + "\n"], ["SHA256SUMS", `${metadata.zipSha256}  ${metadata.zip}\n`]]) {
  if ((await readFile(resolve(root, file), "utf8")) !== expected) throw new Error(`Hash list mismatch: ${file}`);
}
const sourceManifest = await readFile(resolve(root, "SOURCE.sha256"));
if (sha256(sourceManifest) !== metadata.sourceManifestSha256) throw new Error("Source hash-list mismatch");
const sourceLines = sourceManifest.toString("utf8").trimEnd().split("\n");
if (JSON.stringify(sourceLines.map(line => line.slice(66))) !== JSON.stringify([...SOURCE_FILES])) throw new Error("Source hash inventory mismatch");
for (const line of sourceLines) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match || sha256(await safeRead(SOURCE_ROOT, match[2])) !== match[1]) throw new Error("Public source mismatch");
}
console.log(`Verified ${entries.length} ZIP entries, source hashes, permissions and SHA-256 ${metadata.zipSha256}. This does not authenticate a Store download.`);
