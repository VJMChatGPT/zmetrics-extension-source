import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, cp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, win32 } from "node:path";
import { buildRelease, packageRelease, validateRelease, safeRead, isAllowedOutput, SOURCE_ROOT, RELEASE_FILES } from "./build-release.js";
import { SOURCE_FILES } from "./release-files.js";
import { readZip } from "./zip.js";
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "zmetrics-public-release-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(rel.startsWith("zmetrics-public-release-") && !rel.includes("/") && !rel.includes("\\"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function sourceCopy(directory) {
  const root = join(directory, "source"); await mkdir(root);
  for (const file of SOURCE_FILES) {
    const destination = join(root, file); await mkdir(resolve(destination, ".."), { recursive: true });
    await cp(join(SOURCE_ROOT, file), destination);
  }
  return root;
}

test("Windows output boundaries allow another drive while protecting source and ancestors", () => {
  const root = "D:\\work\\source";
  for (const output of ["C:\\Temp\\build", "D:\\Temp\\build", root + "\\dist\\extension"])
    assert.equal(isAllowedOutput(root, output, win32), true, output);
  for (const output of [root, "D:\\work", "D:\\", root + "\\docs\\build", root + "\\dist", root + "\\dist-private\\build"])
    assert.equal(isAllowedOutput(root, output, win32), false, output);
});

test("junction roots are canonicalized without allowing linked files or unsafe outputs", async t => {
  const dir = await temporary(t), root = await sourceCopy(dir), alias = join(dir, "source-alias");
  await symlink(root, alias, "junction");
  assert.deepEqual(await safeRead(alias, "manifest.json"), await readFile(join(root, "manifest.json")));
  await assert.rejects(buildRelease({ root, output: join(alias, "docs", "unsafe-build") }));
  await assert.rejects(buildRelease({ root, output: dir }));
  const outside = join(dir, "outside.txt");
  await writeFile(outside, "outside");
  await assert.rejects(safeRead(alias, "../outside.txt"));
  // Directory junctions need no Windows symlink privilege and remain refused inside source.
  await symlink(dir, join(root, "linked-dir"), "junction");
  await assert.rejects(safeRead(alias, "linked-dir/outside.txt"), /Symlink refused/);
});
test("public build copies the entire approved payload without transformations or private inputs", async t => {
  const dir = await temporary(t), result = await buildRelease({ output: join(dir, "extension") });
  assert.equal(result.version, "1.4.8"); assert.equal(result.files.length, 18);
  for (const file of RELEASE_FILES) assert.deepEqual(await readFile(join(result.directory, file)), await readFile(join(SOURCE_ROOT, file)));
  await assert.rejects(buildRelease({ output: result.directory }));
  await assert.rejects(buildRelease({ output: SOURCE_ROOT }));
  await assert.rejects(buildRelease({ output: join(SOURCE_ROOT, "docs", "unsafe-build") }));
});
test("package validation rejects broader privileges, remote code policy changes and extra files", async t => {
  const dir = await temporary(t), result = await buildRelease({ output: join(dir, "extension") });
  const path = join(result.directory, "manifest.json"), bytes = await readFile(path), base = JSON.parse(bytes);
  for (const patch of [{ permissions: ["storage", "tabs"] }, { host_permissions: ["<all_urls>"] },
    { content_scripts: [{ matches: ["<all_urls>"], js: ["popup.js"] }] },
    { content_security_policy: { extension_pages: "script-src 'self' https:; connect-src *" } },
    { background: { service_worker: "popup.js", type: "module" } }]) {
    await writeFile(path, JSON.stringify({ ...base, ...patch })); await assert.rejects(validateRelease(result.directory));
  }
  await writeFile(path, bytes);
  await writeFile(join(result.directory, "unapproved.txt"), "not part of a release");
  await assert.rejects(validateRelease(result.directory));
});
test("production validation rejects injected private endpoints and remote imports before packaging", async t => {
  const dir = await temporary(t), result = await buildRelease({ output: join(dir, "extension") });
  const path = join(result.directory, "background.js"), bytes = await readFile(path);
  for (const addition of ['\nfetch("http://127.0.0.1:9000/private");\n', '\nimport "https://example.invalid/runtime.js";\n']) {
    await writeFile(path, Buffer.concat([bytes, Buffer.from(addition)])); await assert.rejects(validateRelease(result.directory));
  }
});
test("two separate public-only source copies produce identical ZIPs and complete hash metadata", async t => {
  const first = await temporary(t), second = await temporary(t);
  const aRoot = await sourceCopy(first), bRoot = await sourceCopy(second);
  const a = await packageRelease({ root: aRoot }), b = await packageRelease({ root: bRoot });
  assert.deepEqual(await readFile(a.zip), await readFile(b.zip));
  assert.equal(a.zipSha256, b.zipSha256);
  for (const name of ["FILES.sha256", "SOURCE.sha256", "SHA256SUMS", "release.json"]) {
    assert.deepEqual(await readFile(join(aRoot, "dist", name)), await readFile(join(bRoot, "dist", name)));
  }
  const bytes = await readFile(a.zip), entries = readZip(bytes);
  assert.deepEqual(entries.map(([name]) => name), [...RELEASE_FILES]);
  for (const [name, data] of entries) assert.deepEqual(data, await readFile(join(aRoot, name)));
  const changed = Buffer.from(bytes); changed[70] ^= 1;
  assert.throws(() => readZip(changed));
});
