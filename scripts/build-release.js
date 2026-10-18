import { mkdir, readFile, writeFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { RELEASE_FILES, RUNTIME_FILES, SOURCE_FILES, PRODUCTION_CSP } from "./release-files.js";
import { createZip, readZip } from "./zip.js";
export { RELEASE_FILES } from "./release-files.js";
export const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error(message); };
export const CREDENTIAL_PATTERNS = [
  /AIza[A-Za-z0-9_-]{30,}/, /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}/,
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{25,}|AKIA[0-9A-Z]{16}|sb_secret_[A-Za-z0-9_-]{15,})/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
export function scanCredentials(text, name) {
  if (CREDENTIAL_PATTERNS.some(pattern => pattern.test(text))) fail(`Credential-like content in ${name}; value withheld`);
}
export async function safeRead(root, name) {
  let target = root;
  for (const part of name.split("/")) {
    target = resolve(target, part);
    if ((await lstat(target)).isSymbolicLink()) fail(`Symlink refused: ${name}`);
  }
  if (!(await lstat(target)).isFile()) fail(`Expected file: ${name}`);
  const real = await realpath(target), rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) fail(`File escapes source: ${name}`);
  return readFile(real);
}
export async function listFiles(root, prefix = "", ignored = []) {
  const files = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && ignored.includes(entry.name)) continue;
    if (entry.isSymbolicLink()) fail(`Symlink refused: ${name}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else if (entry.isFile()) files.push(name);
    else fail(`Unsupported file: ${name}`);
  }
  return files.sort();
}
function same(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`Unexpected ${label}`);
}
export async function validateInputs(root) {
  root = await realpath(root);
  const data = new Map();
  for (const file of RELEASE_FILES) data.set(file, await safeRead(root, file));
  const manifest = JSON.parse(data.get("manifest.json").toString("utf8"));
  same(Object.keys(manifest).sort(), ["manifest_version", "name", "version", "description", "action", "background", "permissions", "host_permissions", "content_security_policy", "icons", "commands"].sort(), "manifest fields");
  if (manifest.manifest_version !== 3 || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) fail("Invalid manifest version");
  same(manifest.permissions, ["storage"], "permissions");
  same(manifest.host_permissions, ["https://api.coingecko.com/*"], "host permissions");
  same(manifest.content_security_policy, { extension_pages: PRODUCTION_CSP }, "content security policy");
  same(manifest.background, { service_worker: "background.js", type: "module" }, "background");
  if (manifest.action?.default_popup !== "popup.html") fail("Unexpected popup");
  for (const icon of Object.values(manifest.icons || {})) if (!data.has(icon)) fail("Missing icon");
  for (const [name, bytes] of data) {
    if (/\.(js|html|css|json|md|txt)$/.test(name) || name === "LICENSE") {
      const text = bytes.toString("utf8"); scanCredentials(text, name);
      if (RUNTIME_FILES.includes(name) && /\.(js|html|css|json)$/.test(name)) {
        if (/ai-brief|DEV_AI_|AI_BRIEF|gemini|generativelanguage|localhost|127\.0\.0\.1|supabase|telemetry|analytics|zmetricsToken|zmetricsEmail|fonts\.googleapis|fonts\.gstatic|\beval\s*\(|\bnew\s+Function\s*\(/i.test(text)) fail(`Non-production content: ${name}`);
        for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
          if (!match[1].startsWith("./") || !data.has(match[1].slice(2))) fail(`Unbundled import: ${name}`);
        }
        const assets = name.endsWith(".html") ? [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
          : name.endsWith(".css") ? [...text.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map(m => m[1]) : [];
        if (assets.some(asset => !data.has(asset))) fail(`Unbundled resource: ${name}`);
      }
    }
    if (name.endsWith(".png") && bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail(`Invalid PNG: ${name}`);
    if (name.endsWith(".ttf") && bytes.readUInt32BE(0) !== 0x00010000) fail(`Invalid font: ${name}`);
    if (name.endsWith(".js")) {
      const result = spawnSync(process.execPath, ["--check", resolve(root, name)], { encoding: "utf8" });
      if (result.status !== 0) fail(`JavaScript syntax check failed: ${name}`);
    }
  }
  if (!data.get("fonts/OFL.txt").includes(Buffer.from("SIL OPEN FONT LICENSE Version 1.1"))) fail("Missing font license");
  return { version: manifest.version, files: [...RELEASE_FILES], data };
}
export async function validateRelease(directory) {
  same(await listFiles(directory), [...RELEASE_FILES], "release inventory");
  const { data, ...result } = await validateInputs(directory);
  return result;
}
export async function buildRelease({ root = SOURCE_ROOT, output = resolve(root, "dist/extension") } = {}) {
  root = await realpath(root); output = resolve(output);
  const rel = relative(root, output), back = relative(output, root);
  if (!rel || !back || (!back.startsWith(`..${sep}`) && back !== "..") ||
      (!rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.startsWith(`dist${sep}`))) fail("Output must be a fresh dist subdirectory or an external sibling");
  const { data, ...result } = await validateInputs(root);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Existing output is deliberately never replaced.
  for (const [name, bytes] of data) {
    await mkdir(dirname(resolve(output, name)), { recursive: true });
    await writeFile(resolve(output, name), bytes, { flag: "wx" });
  }
  await validateRelease(output);
  return { directory: output, ...result, hashes: Object.fromEntries([...data].map(([name, bytes]) => [name, sha256(bytes)])) };
}
export async function packageRelease({ root = SOURCE_ROOT, output = resolve(root, "dist/extension") } = {}) {
  const result = await buildRelease({ root, output });
  const entries = [];
  for (const file of result.files) entries.push([file, await readFile(resolve(result.directory, file))]);
  const bytes = createZip(entries); readZip(bytes);
  const directory = dirname(result.directory), zipName = `zmetrics-${result.version}.zip`;
  const zip = resolve(directory, zipName);
  const sourceHashes = [];
  for (const file of SOURCE_FILES) sourceHashes.push(`${sha256(await safeRead(await realpath(root), file))}  ${file}`);
  const sourceManifest = sourceHashes.join("\n") + "\n";
  const metadata = { version: result.version, zip: zipName, zipSha256: sha256(bytes), files: result.hashes,
    sourceManifestSha256: sha256(Buffer.from(sourceManifest)), reference: "Store-delivered 1.4.8 verified 2026-10-18; see docs/release-reference.json", originalUploadZipIdentityVerified: false };
  await writeFile(zip, bytes, { flag: "wx" });
  await writeFile(resolve(directory, "FILES.sha256"), Object.entries(result.hashes).map(([name, hash]) => `${hash}  ${name}`).join("\n") + "\n", { flag: "wx" });
  await writeFile(resolve(directory, "SOURCE.sha256"), sourceManifest, { flag: "wx" });
  await writeFile(resolve(directory, "SHA256SUMS"), `${metadata.zipSha256}  ${zipName}\n`, { flag: "wx" });
  await writeFile(resolve(directory, "release.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
  return { ...result, zip, zipSha256: metadata.zipSha256 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === "--package")) {
    console.error("Usage: node scripts/build-release.js [--package]"); process.exitCode = 1;
  } else {
    (args[0] ? packageRelease() : buildRelease()).then(result => console.log(JSON.stringify(result, null, 2)), error => {
      console.error(error.message); process.exitCode = 1;
    });
  }
}
