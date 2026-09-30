import assert from 'node:assert/strict';
import {
  criticalIntegrationAuditFilters,
  filterCriticalIntegrationAudits,
} from '../netlify/functions/_shared/critical-integration-audit.mjs';

const passed=(id,marker)=>({
  id,
  name:id,
  ok:true,
  status:204,
  source:'live',
  marker,
  expectedMarker:marker,
  lastLiveCheckedAt:'2026-09-01T12:00:00.000Z',
  detail:'passed',
});
const failed=(id,marker)=>({
  ...passed(id,marker),
  ok:false,
  status:503,
  marker:'failed-marker',
  detail:'failed',
});
const ids=[
  ['synthetic-event-documents','event-documents'],
  ['synthetic-vendor-insurance-document','vendor-insurance-document'],
  ['synthetic-quickbooks-webhook','quickbooks-webhook'],
  ['synthetic-signwell-webhook','signwell-webhook'],
];
const probes=(failedId='')=>ids.map(([id,marker])=>id===failedId?failed(id,marker):passed(id,marker));

const releases=[
  {
    deployId:'release-a',
    publishedAt:'2026-09-01T12:00:00.000Z',
    syntheticProbeVerification:{status:'passed',checkedAt:'2026-09-01T12:00:00.000Z',probes:probes()},
  },
  {
    deployId:'release-b',
    publishedAt:'2026-09-15T12:00:00.000Z',
    syntheticProbeVerification:{status:'failed',checkedAt:'2026-09-15T12:00:00.000Z',probes:probes('synthetic-signwell-webhook')},
    rollbackProtection:{status:'rolled-back',targetDeployId:'release-a'},
  },
  {
    deployId:'release-c',
    publishedAt:'2026-09-25T12:00:00.000Z',
    syntheticProbeVerification:{status:'failed',checkedAt:'2026-09-25T12:00:00.000Z',probes:probes('synthetic-quickbooks-webhook')},
  },
];

const dateFilters=criticalIntegrationAuditFilters(new URLSearchParams({from:'2026-09-10',to:'2026-09-20'}));
assert.deepEqual(filterCriticalIntegrationAudits(releases,dateFilters).map((row)=>row.deployId),['release-b']);

const signwellFilters=criticalIntegrationAuditFilters(new URLSearchParams({
  integration:'synthetic-signwell-webhook',
  failedOnly:'1',
}));
const signwell=filterCriticalIntegrationAudits(releases,signwellFilters);
assert.deepEqual(signwell.map((row)=>row.deployId),['release-b']);
assert.deepEqual(signwell[0].syntheticProbeVerification.probes.map((row)=>row.id),['synthetic-signwell-webhook']);

const quickbooksFilters=criticalIntegrationAuditFilters(new URLSearchParams({
  integration:'synthetic-quickbooks-webhook',
  failedOnly:'true',
}));
assert.deepEqual(filterCriticalIntegrationAudits(releases,quickbooksFilters).map((row)=>row.deployId),['release-c']);

const rollbackFilters=criticalIntegrationAuditFilters(new URLSearchParams({rollbackOnly:'yes'}));
assert.deepEqual(filterCriticalIntegrationAudits(releases,rollbackFilters).map((row)=>row.deployId),['release-b']);

assert.throws(
  ()=>criticalIntegrationAuditFilters(new URLSearchParams({integration:'synthetic-unknown'})),
  /Unknown Critical Integrations filter/,
);
assert.throws(
  ()=>criticalIntegrationAuditFilters(new URLSearchParams({from:'2026-09-30',to:'2026-09-01'})),
  /start date must be on or before/,
);

console.log('Critical Integrations audit filter regression passed: date range, integration, failed-only, and rollback-event filters behave independently and together.');
