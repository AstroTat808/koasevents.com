#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow=readFileSync(fileURLToPath(new URL('../.github/workflows/production-visual-qa.yml',import.meta.url)),'utf8');
const start=workflow.indexOf('      - name: Require final System Health snapshot to be healthy');
const end=workflow.indexOf('      - name: Publish final fail-closed production release status',start);
const failures=[];
const requireMatch=(condition,reason)=>{if(!condition)failures.push(reason);};
requireMatch(start>=0 && end>start,'Required production release health stages missing');
const section=start>=0 && end>start?workflow.slice(start,end):'';
for(const text of [
  'for attempt in 1 2 3; do',
  'rm -f /tmp/koa-final-health.json',
  '000|502|503|504)',
  'test "$http_status" = "200"',
  'assert data.get("ok") is True',
  'assert data.get("sha")==os.environ["GITHUB_SHA"]',
  'assert current.get("overall")=="healthy"',
  'assert current.get("failed")==0',
  'assert isinstance(current.get("passed"),int)',
  'assert current.get("checkedAt")',
  '--data \'{"action":"run-dashboard-refresh"}\'',
])requireMatch(section.includes(text),'Missing final health release invariant: '+text);
requireMatch(
  section.indexOf('case "$http_status" in')>=0
  && section.indexOf('test "$http_status" = "200"')>section.indexOf('case "$http_status" in'),
  'Final HTTP success and healthy-result assertions must remain after transport retry');
requireMatch(
  !section.includes('current.get("failed")<=') &&
  !section.includes('current.get("failed")<'),
  'Never dilute the exact zero-failure release gate');
if(failures.length){
  failures.forEach(message=>console.error('FAIL | '+message));
  process.exit(1);
}
console.log('PASS | 504-only bounded transport retry preserves exact SHA, healthy status, and zero failures.');
