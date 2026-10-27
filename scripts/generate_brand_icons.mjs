#!/usr/bin/env node
/** Generate PNG icons from the exact SVG favicon used by the website navbar. */
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const logoPath = new URL('../public/brand/koa-mark.png', import.meta.url);
const faviconPath = new URL('../public/brand/koa-navbar-favicon.svg', import.meta.url);
const outputs = [
  { size: 180, path: new URL('../public/apple-touch-icon.png', import.meta.url) },
  { size: 32, path: new URL('../public/brand/koa-navbar-favicon-32.png', import.meta.url) },
];

async function main() {
  const logo = await readFile(logoPath);
  const faviconSvg = await readFile(faviconPath, 'utf8');
  if (!faviconSvg.includes('data:image/png;base64,' + logo.toString('base64'))) {
    throw new Error('Favicon artwork differs from the canonical navbar image; update the SVG before building.');
  }
  if (!faviconSvg.includes('fill="url(#ivory)"')) {
    throw new Error('Favicon must retain its light ivory medallion in every theme.');
  }
  for (const { size, path } of outputs) {
    const png = await sharp(Buffer.from(faviconSvg), { density: 288 })
      .flatten({ background: '#fffdf8' })
      .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== size || info.height !== size || info.channels !== 3) {
      throw new Error('Invalid ' + size + 'x' + size + ' brand icon dimensions or channels.');
    }
    let dark = 0;
    for (let i = 0; i < data.length; i += 3) {
      if (data[i] < 160 && data[i + 1] < 160 && data[i + 2] < 160) dark++;
    }
    if (dark < size * size * 0.035) {
      throw new Error('Missing Koa logo artwork in the ' + size + 'x' + size + ' icon.');
    }
    const topLeft = data.subarray(0, 3);
    if ([...topLeft].some(channel => channel < 225)) {
      throw new Error('The ' + size + 'x' + size + ' icon must have a light background.');
    }
    await writeFile(path, png);
    console.log('[koa branding] ' + size + 'x' + size + ' icon generated and validated.');
  }
}
main().catch(error => { console.error('[koa branding] ' + error.message); process.exitCode = 1; });
