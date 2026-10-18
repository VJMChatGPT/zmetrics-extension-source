import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_ROOT, safeRead, listFiles, sha256 } from './build-release.js';
import { RELEASE_FILES } from './release-files.js';
import assert from 'node:assert/strict';
export async function verifyStore(directory) {
  const ref=JSON.parse(await readFile(resolve(SOURCE_ROOT,'docs/release-reference.json'),'utf8'));
  const allowed=ref.storeDifferences.addedFiles;
  assert.deepEqual(await listFiles(directory),[...RELEASE_FILES,...Object.keys(allowed)].sort(),'Store inventory mismatch');
  const actual=JSON.parse(await safeRead(directory,'manifest.json'));
  assert.equal(actual.update_url,ref.storeDifferences.manifestAddedField.update_url,'Unexpected update URL');
  delete actual.update_url;
  const expected=JSON.parse(await safeRead(SOURCE_ROOT,'manifest.json'));
  assert.deepEqual(actual,expected,'Store manifest mismatch');
  for(const name of RELEASE_FILES.filter(n=>n!=='manifest.json')) {
    assert.equal(sha256(await safeRead(directory,name)),ref.files[name],`Store payload mismatch: ${name}`);
  }
  for(const [name,hash] of Object.entries(allowed)) assert.equal(sha256(await safeRead(directory,name)),hash,`Store metadata mismatch: ${name}`);
  return {version:actual.version,files:RELEASE_FILES.length,knownStoreAdditions:Object.keys(allowed),payloadMatches:true,signatureVerified:false,scope:'Payload comparison only; authenticate CRX separately. Exact uploaded ZIP identity is not established.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==3) throw Error('Usage: node scripts/verify-store.js EXTRACTED_STORE_DIRECTORY');
  console.log(JSON.stringify(await verifyStore(resolve(process.argv[2])),null,2));
}
