// Fail-closed validation for synthetic, PII-free System Health accordion evidence.
// Only four fixed browser/viewport slots are accepted for the current exact release.
export const ACCORDION_EVIDENCE_CASES = Object.freeze([
  { key: 'chromium-phone', browser: 'chromium', viewport: 'phone', width: 390, height: 844 },
  { key: 'chromium-desktop', browser: 'chromium', viewport: 'desktop', width: 1440, height: 900 },
  { key: 'webkit-phone', browser: 'webkit', viewport: 'phone', width: 390, height: 844 },
  { key: 'webkit-desktop', browser: 'webkit', viewport: 'desktop', width: 1440, height: 900 },
]);
export const ACCORDION_ASSERTIONS = Object.freeze([
  'initialClosed', 'criticalInitiallyOpen', 'manuallyOpened', 'manuallyClosed',
  'criticalForcedOpen', 'recoveredCollapsed',
]);

export function validateAccordionReleaseEvidence(evidence, { commit, deployId, runId }) {
  if (!evidence || evidence.source !== 'synthetic-health-qa'
      || evidence.commit !== commit || evidence.deployId !== deployId
      || evidence.runId !== runId || !Array.isArray(evidence.results)
      || evidence.results.length !== ACCORDION_EVIDENCE_CASES.length) {
    throw new Error('Accordion evidence missing, incomplete, or for another exact release.');
  }
  const slots = new Map();
  for (const row of evidence.results) {
    const expected = ACCORDION_EVIDENCE_CASES.find(item => item.key === row?.key);
    if (!expected || slots.has(expected.key) || row?.browser !== expected.browser
        || row?.viewport !== expected.viewport || row?.width !== expected.width
        || row?.height !== expected.height || row?.synthetic !== true
        || row?.status !== 'passed' || row?.route !== '/admin/health/'
        || !row?.results || ACCORDION_ASSERTIONS.some(test => row.results[test] !== true)) {
      throw new Error('Invalid accordion result for exact browser, viewport, or required assertion.');
    }
    const bytes = String(row.dataBase64 || '');
    if (bytes.length < 1500 || bytes.length > 350000
        || !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(bytes)
        || !/^[a-f0-9]{64}$/.test(String(row.sha256 || ''))) {
      throw new Error('Synthetic accordion screenshot missing, malformed, or over maximum size.');
    }
    slots.set(expected.key, {
      ...expected, route: '/admin/health/', status: 'passed',
      synthetic: true, contentType: 'image/jpeg', results: ACCORDION_ASSERTIONS.reduce(
        (acc, key) => ({ ...acc, [key]: true }), {},
      ),
      sha256: row.sha256, dataBase64: bytes,
    });
  }
  if (slots.size !== ACCORDION_EVIDENCE_CASES.length) {
    throw new Error('Required Chromium/WebKit desktop and iPhone evidence slots are incomplete.');
  }
  return {
    status: 'passed', source: 'synthetic-health-qa', commit, deployId, runId,
    results: ACCORDION_EVIDENCE_CASES.map(row => slots.get(row.key)),
  };
}
