import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mediaPath = path.join(root, 'src/data/media.ts');
const mediaText = fs.readFileSync(mediaPath, 'utf8');
const outDir = path.join(root, 'public/downloads');
fs.mkdirSync(outDir, { recursive: true });

const mapping = Object.fromEntries(
  [...mediaText.matchAll(/^\s{2}(\w+): koaMarketing\('([^']+)'/gm)].map((m) => [m[1], m[2]])
);

const galleryBlock = mediaText.split('export const koaMarketingGallery = [')[1].split('];')[0];
const curated = [...galleryBlock.matchAll(/koaMarketingMedia\.(\w+), category: '([^']+)'/g)]
  .map((m) => ({ prop: m[1], category: m[2] }));

const idsBlock = mediaText.split('const galleryIds = [')[1].split('];')[0];
const legacyIds = [...idsBlock.matchAll(/'([^']+\.(?:jpg|jpeg|png|webp))'/gi)].map((m) => m[1]);

let liveState = { uploads: [], hiddenCurated: [] };
try {
  const response = await fetch('https://www.koasevents.com/api/gallery', { signal: AbortSignal.timeout(15000) });
  if (response.ok) liveState = await response.json();
} catch {}

const hidden = new Set(liveState.hiddenCurated || []);
const files = [];
const manifest = [];
const counts = {};

function safeName(value) {
  return String(value || 'image').replace(/[^A-Za-z0-9._ -]+/g, '-').trim() || 'image';
}

for (const item of curated) {
  const filename = mapping[item.prop];
  if (!filename) continue;
  const src = '/media/koa/' + filename;
  if (hidden.has(src)) continue;
  const sourcePath = path.join(root, 'public', src.replace(/^\//, ''));
  if (!fs.existsSync(sourcePath)) continue;
  counts[item.category] = (counts[item.category] || 0) + 1;
  const archivePath = `${safeName(item.category)}/${String(counts[item.category]).padStart(2, '0')}_${filename}`;
  const data = fs.readFileSync(sourcePath);
  files.push({ name: archivePath, data });
  manifest.push({ section: item.category, source: src, file: archivePath });
}

legacyIds.forEach((filename, index) => {
  const sourcePath = path.join(root, 'public/media/wix', filename);
  if (!fs.existsSync(sourcePath)) return;
  const archivePath = `Legacy Archive/${String(index + 1).padStart(2, '0')}_${filename}`;
  const data = fs.readFileSync(sourcePath);
  files.push({ name: archivePath, data });
  manifest.push({ section: 'Legacy Archive', source: '/media/wix/' + filename, file: archivePath });
});

for (let i = 0; i < (liveState.uploads || []).length; i++) {
  const item = liveState.uploads[i];
  if (!item?.src) continue;
  try {
    const response = await fetch('https://www.koasevents.com' + item.src, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) continue;
    const data = Buffer.from(await response.arrayBuffer());
    const ext = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
    }[item.contentType] || '.img';
    const archivePath = `Recently Added/${String(i + 1).padStart(2, '0')}_${safeName(item.alt || item.id || 'upload').slice(0, 80)}${ext}`;
    files.push({ name: archivePath, data });
    manifest.push({ section: 'Recently Added', source: item.src, file: archivePath, category: item.category || '' });
  } catch {}
}

const manifestData = Buffer.from(JSON.stringify({
  generatedFrom: 'https://www.koasevents.com/gallery/',
  hiddenCuratedExcluded: [...hidden],
  liveUploadCountReported: (liveState.uploads || []).length,
  imageCount: manifest.length,
  files: manifest,
}, null, 2));
files.push({ name: 'manifest.json', data: manifestData });

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const localParts = [];
const centralParts = [];
let offset = 0;

for (const file of files) {
  const name = Buffer.from(file.name.replace(/\\/g, '/'));
  const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  localParts.push(local, name, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);

  offset += local.length + name.length + data.length;
}

const centralDir = Buffer.concat(centralParts);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralDir.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...localParts, centralDir, eocd]);
const output = path.join(outDir, 'Koa_Events_Gallery_Photos.zip');
fs.writeFileSync(output, zip);
console.log(`Gallery ZIP generated with ${manifest.length} images at ${output}`);
