#!/usr/bin/env node
// Mail clients may invert CSS background colors in Dark Mode.  The CID logo
// must therefore contain its own opaque white pixels, not transparency.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root=fileURLToPath(new URL('../',import.meta.url));
const file=(p)=>readFile(path.join(root,p));
const asset=await file('public/brand/koa-email-white-medallion.png');
const code=(await file('netlify/functions/_shared/email-brand.ts')).toString('utf8');
const preview=(await file('src/pages/admin/email-preview/index.astro')).toString('utf8');
const health=(await file('netlify/functions/_shared/system-health.ts')).toString('utf8');
const emailHealth=(await file('netlify/functions/_shared/email-health.ts')).toString('utf8');

const constant=code.match(/const EMAIL_LOGO_BASE64 = '([a-zA-Z0-9+/=]+)';/);
assert.ok(constant,'Outbound email must embed a fixed CID logo');
assert.ok(Buffer.from(constant[1],'base64').equals(asset),'CID logo bytes must match the approved public white-backed asset');
assert.match(code,/return 'cid:' \+ EMAIL_LOGO_CONTENT_ID/,'All outbound emails must embed a CID logo');
assert.match(code,/content: EMAIL_LOGO_BASE64/,'CID attachment must use approved bytes');
assert.match(code,/content_type: 'image\/png'/,'CID logo must remain a PNG');
assert.ok(code.includes('background-color:#ffffff;'),'Email image fallback must be white');
assert.ok(preview.includes("const logo=()=>'/brand/koa-email-white-medallion.png'"),'Admin preview must show the exact approved asset');
assert.ok(health.includes("emailHeader({brand:'events'"),'System Health emails must use the shared header');
assert.ok(health.includes('emailLogoAttachment()'),'System Health emails must attach the CID logo');
assert.ok(health.includes("path:'/brand/koa-email-white-medallion.png'"),'System Health must display actual white-backed email logo path');
assert.ok(emailHealth.includes("? '/brand/koa-email-white-medallion.png'"),'Runtime Koa logo monitor must check the actual white-backed CID asset');

const meta=await sharp(asset).metadata();
assert.equal(meta.format,'png','Email logo must be a PNG');
assert.equal(meta.width,128,'Mail logo must have 2x resolution for a 64px rendered emblem');
assert.equal(meta.height,128,'Mail logo must be square');
assert.equal(meta.hasAlpha,false,'Mail logo must have no transparency');
const {data,info}=await sharp(asset).ensureAlpha().raw().toBuffer({resolveWithObject:true});
assert.equal(info.channels,4,'Inspect RGBA logo pixels');
const pixel=(x,y)=>[...data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4)];
for(const [x,y] of [[0,0],[127,0],[0,127],[127,127],[0,64],[64,0],[127,64],[64,127]]){
  assert.deepEqual(pixel(x,y),[255,255,255,255],`Logo background at (${x},${y}) must be opaque white`);
}
for(let n=3;n<data.length;n+=4)assert.equal(data[n],255,'Email logo must not contain any transparent pixels');
assert.ok(pixel(64,64).slice(0,3).some(n=>n<235),'Central emblem must retain visible brand artwork');
console.log('PASS | Email CID image is pixel-identical to approved opaque white-backed 128px PNG.');
console.log('PASS | White pixels survive mail-client theme changes; admin preview and System Health use the same image.');
