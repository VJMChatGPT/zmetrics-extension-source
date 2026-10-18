import { readFile } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import assert from 'node:assert/strict';
if (process.argv.length!==3) throw Error('Usage: node scripts/verify-crx.js PACKAGE.crx');
const bytes = await readFile(process.argv[2]);
// Chromium publisher pin, reviewed 2026-10-18. No publisher test key accepted.
const pin = { publisherKeySha256:'61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf', source:'https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/crx_verifier.cc' };
assert.equal(bytes.subarray(0,4).toString(), 'Cr24'); assert.equal(bytes.readUInt32LE(4),3);
const size=bytes.readUInt32LE(8); assert.ok(size>0 && size<1024*1024 && 12+size<bytes.length);
const header=bytes.subarray(12,12+size), archive=bytes.subarray(12+size);
for (const token of ['504b0506','504b0607','504b0606']) assert.equal(header.includes(Buffer.from(token,'hex')),false);
function fields(b) {
  let i=0; const values=[];
  function varint() { let n=0, shift=0; for(let count=0;count<5;count++) {assert.ok(i<b.length);const v=b[i++];n+=(v&127)*2**shift;if(!(v&128)) return n;shift+=7;}throw Error('Oversized protobuf varint'); }
  while(i<b.length) {const tag=varint();assert.equal(tag&7,2);const len=varint();assert.ok(i+len<=b.length);values.push([Math.floor(tag/8),b.subarray(i,i+len)]);i+=len;}return values;
}
const f=fields(header), signed=f.filter(([n])=>n===10000); assert.equal(signed.length,1);
const sd=signed[0][1], ids=fields(sd).filter(([n])=>n===1);assert.equal(ids.length,1);assert.equal(ids[0][1].length,16);
const hex=ids[0][1].toString('hex'), id=[...hex].map(x=>String.fromCharCode(97+parseInt(x,16))).join('');
assert.equal(id,'ipihfpalipjpdoboegoemfhfldcpdeke');
const len=Buffer.alloc(4);len.writeUInt32LE(sd.length);
const input=Buffer.concat([Buffer.from('CRX3 SignedData\0'),len,sd,archive]);
const proofs=[];
for(const [type,b] of f.filter(([n])=>n===2||n===3)) {
  const p=fields(b), keys=p.filter(([n])=>n===1), sigs=p.filter(([n])=>n===2);assert.equal(keys.length,1);assert.equal(sigs.length,1);
  const key=keys[0][1], hash=createHash('sha256').update(key).digest('hex');
  const pub=createPublicKey({key,format:'der',type:'spki'});assert.equal(pub.asymmetricKeyType,type===2?'rsa':'ec');
  assert.ok(verify('sha256',input,pub,sigs[0][1]),'Invalid CRX signature');
  proofs.push({algorithm:type===2?'RSA-PKCS1-SHA256':'ECDSA-SHA256',publicKeySha256:hash,valid:true,extensionIdentity:hash.startsWith(hex),pinnedStorePublisher:hash===pin.publisherKeySha256});
}
assert.ok(proofs.some(p=>p.extensionIdentity));assert.ok(proofs.some(p=>p.pinnedStorePublisher));
const result={extensionId:id,version:3,crxSha256:createHash('sha256').update(bytes).digest('hex'),proofs,allSignaturesValid:true,extensionIdentityValid:true,pinnedStorePublisherValid:true,pinSource:pin.source,scope:'Checks CRX3 identity, all archive signatures and Chromium publisher pin; does not recover original uploaded ZIP or replace Chrome installation/content verification.'};
console.log(JSON.stringify(result,null,2));
