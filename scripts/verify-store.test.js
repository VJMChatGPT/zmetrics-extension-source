import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,relative,join } from 'node:path';
import { SOURCE_ROOT } from './build-release.js';
import { RELEASE_FILES } from './release-files.js';
import { verifyStore } from './verify-store.js';
test('Store comparison rejects injected files, payload changes and broader permissions',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'zmetrics-store-check-'));
  t.after(async()=>{const rel=relative(resolve(tmpdir()),dir);assert.ok(rel.startsWith('zmetrics-store-check-')&&!rel.includes('/')&&!rel.includes('\\'));await rm(dir,{recursive:true,force:true});});
  for(const n of RELEASE_FILES){await mkdir(resolve(dir,n,'..'),{recursive:true});await cp(resolve(SOURCE_ROOT,n),resolve(dir,n));}
  await assert.rejects(verifyStore(dir)); // Missing Store fields/metadata.
  const ref=JSON.parse(await readFile(resolve(SOURCE_ROOT,'docs/release-reference.json')));
  const manifest=JSON.parse(await readFile(join(dir,'manifest.json')));
  manifest.update_url=ref.storeDifferences.manifestAddedField.update_url;
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  // The exact metadata is deliberately not generated: it must come from Google.
  await mkdir(join(dir,'_metadata'));await writeFile(join(dir,'_metadata/verified_contents.json'),'forged');
  await assert.rejects(verifyStore(dir),/metadata mismatch/);
  manifest.permissions.push('tabs');await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(verifyStore(dir),/manifest mismatch/);
  manifest.permissions.pop();manifest.update_url='https://example.invalid/update';
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await assert.rejects(verifyStore(dir),/update URL/);
  manifest.update_url=ref.storeDifferences.manifestAddedField.update_url;
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  await writeFile(join(dir,'background.js'),'injected');await assert.rejects(verifyStore(dir),/payload mismatch/);
  await writeFile(join(dir,'unexpected.js'),'injected');await assert.rejects(verifyStore(dir),/inventory mismatch/);
});
