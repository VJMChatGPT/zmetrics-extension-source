// Deterministic ZIP (stored entries): no compression library, timestamps or OS attributes.
// Small release archives only: ZIP64, directories and arbitrary paths are not supported.
const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function createZip(entries) {
  if (entries.length > 65535) throw new Error("Too many ZIP entries");
  const local = [], central = [], names = new Set();
  let offset = 0;
  for (const [name, bytes] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..") || names.has(name)) throw new Error("Invalid ZIP path");
    names.add(name);
    const path = Buffer.from(name), data = Buffer.from(bytes), crc = crc32(data);
    if (data.length > 0xffffffff || path.length > 65535) throw new Error("ZIP entry too large");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // UTF-8; method 0 (stored).
    header.writeUInt16LE(0x21, 12); // 1980-01-01, 00:00:00 DOS timestamp.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(path.length, 26);
    local.push(header, path, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(path.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, path); offset += header.length + path.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  if (offset + directory.length > 0xffffffff) throw new Error("ZIP64 is not supported");
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
// Strict reader for packages produced above. Rebuilding proves CRCs, order, headers and content.
export function readZip(bytes) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > bytes.length || bytes.readUInt16LE(offset + 6) !== 0x800 || bytes.readUInt16LE(offset + 8) !== 0) throw new Error("Unsupported ZIP");
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + length + extra, stop = start + size;
    if (stop > bytes.length) throw new Error("Truncated ZIP");
    entries.push([bytes.subarray(offset + 30, offset + 30 + length).toString("utf8"), bytes.subarray(start, stop)]);
    offset = stop;
  }
  if (!createZip(entries).equals(bytes)) throw new Error("ZIP integrity or format mismatch");
  return entries;
}
