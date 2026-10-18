import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SOURCE_FILES } from "./release-files.js";
import { SOURCE_ROOT, listFiles, safeRead, scanCredentials, validateInputs } from "./build-release.js";
const found = await listFiles(SOURCE_ROOT, "", [".git", "dist", "coverage"]);
if (JSON.stringify(found) !== JSON.stringify(SOURCE_FILES)) throw new Error("Public source inventory mismatch; review additions/removals explicitly");
for (const file of SOURCE_FILES) {
  if (!/\.(png|ttf)$/.test(file)) scanCredentials((await safeRead(SOURCE_ROOT, file)).toString("utf8"), file);
}
const pkg = JSON.parse(await readFile(resolve(SOURCE_ROOT, "package.json"), "utf8"));
const result = await validateInputs(SOURCE_ROOT);
if (pkg.license !== "UNLICENSED" || pkg.version !== result.version || pkg.dependencies || pkg.devDependencies) throw new Error("Version mismatch or unexpected dependencies");
console.log(`Validated ${found.length} public source files; ${result.files.length} package files; version ${result.version}. Pattern scanning is not a security guarantee.`);
