import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SOURCE_ROOT, sha256, safeRead } from "./build-release.js";
import { RUNTIME_FILES } from "./release-files.js";
const root = process.argv[2] ? resolve(process.argv[2]) : SOURCE_ROOT;
const reference = JSON.parse(await readFile(resolve(SOURCE_ROOT, "docs/release-reference.json"), "utf8"));
const manifest = JSON.parse(await safeRead(root, "manifest.json"));
if (manifest.version !== reference.version) throw new Error("Reference applies only to its recorded version; review and establish a new reference for a future release");
if (JSON.stringify(Object.keys(reference.files).sort()) !== JSON.stringify([...RUNTIME_FILES].sort())) throw new Error("Incomplete reference inventory");
for (const [name, hash] of Object.entries(reference.files)) {
  if (sha256(await safeRead(root, name)) !== hash) throw new Error(`Reference mismatch: ${name}`);
}
console.log(`All ${RUNTIME_FILES.length} runtime/assets match the reviewed ${reference.version} source payload matched against Google-delivered 1.4.8 on 2026-10-18. Exact original upload ZIP identity remains unconfirmed.`);
