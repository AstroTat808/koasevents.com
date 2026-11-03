import { createHash } from 'node:crypto';

// Same payload + same verified contact + event within a short retry window.
// Never suppress a distinct event, brand, service, or changed inquiry answers.
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const clean = value => String(value ?? '').trim();
const email = row => clean(row?.customer?.email).toLowerCase();
const date = row => clean(row?.customer?.eventDate).slice(0, 10);
const normalized = row => ({
  formName: clean(row.source),
  businessLine: clean(row.businessLine),
  packageId: clean(row.packageId),
  quoteId: clean(row.quoteId),
  customer: {
    name: clean(row.customer?.name).toLowerCase().replace(/\s+/g, ' '),
    email: email(row),
    phone: clean(row.customer?.phone).replace(/\D/g, ''),
    eventDate: date(row),
    notes: clean(row.customer?.notes),
  },
  inquiry: row.inquiry || {},
  wildOnes: row.wildOnes || null,
});

export function inquiryReplayFingerprint(row) {
  return createHash('sha256').update(stable(normalized(row))).digest('hex');
}

export function findInquiryReplay(records, candidate, { now = Date.now(), windowMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!Array.isArray(records)) return { replay: null, reason: '', conflict: false };
  const requestId = clean(candidate.submissionId);
  const fingerprint = inquiryReplayFingerprint(candidate);
  for (const existing of records) {
    if (!existing || existing.mergedInto) continue;
    if (requestId && existing.submissionId === requestId) {
      return existing.inquiryFingerprint === fingerprint ||
          (!existing.inquiryFingerprint && inquiryReplayFingerprint(existing) === fingerprint)
        ? { replay: existing, reason: 'submission_id', conflict: false }
        : { replay: existing, reason: 'submission_id_reused', conflict: true };
    }
    if (!email(candidate) || !date(candidate) || email(existing) !== email(candidate) || date(existing) !== date(candidate)) continue;
    if (clean(existing.source) !== clean(candidate.source) || clean(existing.businessLine) !== clean(candidate.businessLine)) continue;
    const createdAt = Date.parse(clean(existing.createdAt));
    if (!Number.isFinite(createdAt) || now - createdAt < 0 || now - createdAt > windowMs) continue;
    const prior = existing.inquiryFingerprint || inquiryReplayFingerprint(existing);
    if (fingerprint === prior) return { replay: existing, reason: 'exact_replay', conflict: false };
  }
  return { replay: null, reason: '', conflict: false };
}
