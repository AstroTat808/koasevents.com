import assert from 'node:assert/strict';
import { normalizeLodgingPreference, sameStayLodgingChoice, validateStayInquiry } from '../netlify/functions/_shared/lodging-inquiry.ts';

const request = (overrides = {}) => ({
  lodgingPreference: 'three-bedroom',
  guestCount: '2',
  arrival: '2026-12-01',
  departure: '2026-12-05',
  ...overrides,
});

for (const option of ['three-bedroom', 'two-bedroom', 'both', 'either']) {
  const result = validateStayInquiry(request({ lodgingPreference: option }));
  assert.equal(result.ok, true, `Valid ${option} selection must be accepted`);
  assert.equal(result.lodgingPreference, option);
}
assert.equal(validateStayInquiry(request({ lodgingPreference: undefined })).lodgingPreference, 'not-specified',
  'Legacy in-flight form clients must still be accepted safely');

for (const entry of [
  request({ lodgingPreference: 'invalid-house' }),
  request({ guestCount: '11' }),
  request({ guestCount: '0' }),
  request({ guestCount: '1.5' }),
  request({ guestCount: 'abc' }),
  request({ departure: '2026-12-01' }),
  request({ departure: '2026-11-30' }),
  request({ arrival: '2026-02-30' }),
  request({ arrival: '2026-14-01' }),
  request({ departure: '' }),
]) {
  assert.equal(validateStayInquiry(entry).ok, false, `Invalid stay request was accepted: ${JSON.stringify(entry)}`);
}
assert.equal(normalizeLodgingPreference('<script>'), null);
assert.equal(sameStayLodgingChoice('three-bedroom', 'three-bedroom'), true);
assert.equal(sameStayLodgingChoice('three-bedroom', 'two-bedroom'), false,
  'Requests for two different homes must not be deduplicated');
assert.equal(sameStayLodgingChoice(undefined, 'not-specified'), true,
  'Older records without lodging preference must compare as legacy requests');
assert.equal(sameStayLodgingChoice('both', 'either'), false);

console.log('Stay lodging choice, guest limit, dates and cross-home deduplication: PASS');
