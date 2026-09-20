globalThis.Netlify = {
  env: {
    get(name) {
      return name === 'TURNSTILE_SECRET_KEY' ? 'koa-security-test-secret' : '';
    },
  },
};

const { analyzeInquirySecurity } = await import('../netlify/functions/_shared/security.ts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function payload(overrides = {}) {
  return {
    customer: {
      email: 'couple@gmail.com',
      phone: '8085551212',
      notes: '',
      ...(overrides.customer || {}),
    },
    inquiry: {
      priorities: 'We are planning a wedding for our family and would like to check availability.',
      eventLocation: 'Hilo, Hawaii',
      ...(overrides.inquiry || {}),
    },
  };
}

async function run() {
  const clean = await analyzeInquirySecurity(payload(), [], 'source-clean');
  assert(clean.disposition === 'allowed', 'Normal event inquiry should remain allowed.');

  const suspiciousPhone = await analyzeInquirySecurity(
    payload({ customer: { phone: '1111111111' } }),
    [],
    'source-phone',
  );
  assert(suspiciousPhone.disposition === 'flagged', 'Synthetic phone number should be flagged.');
  assert(suspiciousPhone.reasonCodes.includes('suspicious_phone'), 'Synthetic phone reason missing.');

  const linked = await analyzeInquirySecurity(
    payload({ inquiry: { priorities: 'Here is our inspiration: https://example.com/setup' } }),
    [],
    'source-link',
  );
  assert(linked.disposition === 'flagged', 'An external URL should be flagged for review.');
  assert(linked.reasonCodes.includes('external_link'), 'External URL reason missing.');

  const disposable = await analyzeInquirySecurity(
    payload({ customer: { email: 'couple@mailinator.com' } }),
    [],
    'source-disposable',
  );
  assert(disposable.disposition === 'flagged', 'Disposable email should be flagged.');
  assert(disposable.reasonCodes.includes('disposable_email'), 'Disposable email reason missing.');

  const solicitation = await analyzeInquirySecurity(
    payload({
      customer: { email: 'sales@example.com' },
      inquiry: {
        priorities: 'We offer SEO backlinks and lead generation. Visit https://spam.example.com for our marketing services.',
      },
    }),
    [],
    'source-solicitation',
  );
  assert(solicitation.disposition === 'blocked', 'SEO solicitation with a link should be blocked.');
  assert(solicitation.reasonCodes.includes('marketing_solicitation'), 'Marketing solicitation reason missing.');

  const crypto = await analyzeInquirySecurity(
    payload({
      inquiry: {
        priorities: 'Investment opportunity in crypto and bitcoin. Join our trading platform at https://crypto.example.com.',
      },
    }),
    [],
    'source-crypto',
  );
  assert(crypto.disposition === 'blocked', 'Crypto solicitation with a link should be blocked.');
  assert(crypto.reasonCodes.includes('crypto_pitch'), 'Crypto reason missing.');

  const duplicateSeed = await analyzeInquirySecurity(payload(), [], 'source-duplicate');
  const duplicate = await analyzeInquirySecurity(
    payload(),
    [{
      id: 'SEC-TEST',
      createdAt: new Date().toISOString(),
      disposition: 'allowed',
      category: 'inquiry_screened',
      formName: 'koa-event-inquiry',
      reasons: [],
      reasonCodes: [],
      riskScore: 0,
      ipFingerprint: 'other-source',
      emailDomain: 'gmail.com',
      emailPreview: 'c***@gmail.com',
      phonePreview: '•••1212',
      messageFingerprint: duplicateSeed.messageFingerprint,
      recordId: 'KEI-TEST',
      detail: '',
    }],
    'source-duplicate',
  );
  assert(duplicate.disposition === 'flagged', 'A repeated message should be flagged.');
  assert(duplicate.reasonCodes.includes('duplicate_message'), 'Duplicate-message reason missing.');

  const recent = Array.from({ length: 6 }, (_, index) => ({
    id: 'SEC-RATE-' + index,
    createdAt: new Date(Date.now() - index * 30_000).toISOString(),
    disposition: 'allowed',
    category: 'inquiry_screened',
    formName: 'koa-event-inquiry',
    reasons: [],
    reasonCodes: [],
    riskScore: 0,
    ipFingerprint: 'source-rate',
    emailDomain: 'gmail.com',
    emailPreview: 'c***@gmail.com',
    phonePreview: '•••1212',
    messageFingerprint: 'different-' + index,
    recordId: 'KEI-RATE-' + index,
    detail: '',
  }));
  const velocity = await analyzeInquirySecurity(payload(), recent, 'source-rate');
  assert(velocity.velocityBlocked === true, 'Verified submission velocity limit should trip after six recent submissions.');

  console.log('PASS | normal inquiry allowed');
  console.log('PASS | suspicious phone flagged');
  console.log('PASS | external URL flagged');
  console.log('PASS | disposable email flagged');
  console.log('PASS | SEO solicitation + link blocked');
  console.log('PASS | crypto solicitation + link blocked');
  console.log('PASS | repeated message flagged');
  console.log('PASS | verified-submission velocity limit detected');
}

await run();
