import { createHmac, timingSafeEqual } from 'node:crypto';

const LABEL='koa-system-health-synthetic-v1';

function seed(){
  return String(Netlify.env.get('NETLIFY_AUTH_TOKEN')||'').trim();
}

export function syntheticHealthToken(){
  const value=seed();
  return value?createHmac('sha256',value).update(LABEL,'utf8').digest('hex'):'';
}

export function isSyntheticHealthRequest(req:Request){
  const expected=syntheticHealthToken();
  const received=String(req.headers.get('x-koa-synthetic-token')||'').trim();
  if(!expected||!received)return false;
  const a=Buffer.from(expected);
  const b=Buffer.from(received);
  return a.length===b.length&&timingSafeEqual(a,b);
}
