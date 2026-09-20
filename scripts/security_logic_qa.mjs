globalThis.Netlify = {
  env: {
    get(name) {
      return name === 'TURNSTILE_SECRET_KEY' ? 'koa-security-test-secret' : '';
    },
  },
};

const { analyzeInquirySecurity, automaticBlockDecision } = await import('../netlify/functions/_shared/security.ts');

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

  const finance = await analyzeInquirySecurity(
    payload({
      inquiry: {
        priorities: 'We can offer a pre-approved business loan and working capital. Visit https://funding.example.com today.',
      },
    }),
    [],
    'source-finance',
  );
  assert(finance.disposition === 'blocked', 'Funding solicitation with a link should be blocked.');
  assert(finance.reasonCodes.includes('finance_solicitation'), 'Finance solicitation reason missing.');

  const gambling = await analyzeInquirySecurity(
    payload({
      inquiry: {
        priorities: 'Promote our online casino and sportsbook at https://casino.example.com with a casino bonus.',
      },
    }),
    [],
    'source-gambling',
  );
  assert(gambling.disposition === 'blocked', 'Gambling solicitation should be blocked.');
  assert(gambling.reasonCodes.includes('gambling_solicitation'), 'Gambling solicitation reason missing.');

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
  console.log('PASS | finance solicitation + link blocked');
  console.log('PASS | gambling solicitation blocked');
  console.log('PASS | repeated message flagged');
  const abuseEvent = (index, hoursAgo = 0, review = null) => ({
    id: 'SEC-ABUSE-' + index,
    createdAt: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    disposition: 'blocked',
    category: 'inquiry_screened',
    formName: 'koa-event-inquiry',
    reasons: ['test abuse'],
    reasonCodes: ['test_abuse'],
    riskScore: 100,
    ipFingerprint: 'network-abuse',
    emailDomain: 'spam.example',
    emailFingerprint: 'email-abuse',
    emailPreview: 's***@spam.example',
    phonePreview: '•••9999',
    messageFingerprint: 'message-' + index,
    recordId: '',
    detail: '',
    ...(review ? { review } : {}),
  });

  const email24h = automaticBlockDecision(
    [abuseEvent(1), abuseEvent(2, 1), abuseEvent(3, 2)],
    { emailFingerprint: 'email-abuse', networkFingerprint: 'network-other' },
  );
  assert(email24h.some((decision) => decision.target === 'email' && decision.duration === '24h'), 'Email should auto-block for 24h after 3 abusive incidents in 24 hours.');

  const email7d = automaticBlockDecision(
    Array.from({ length: 6 }, (_, index) => abuseEvent(index, index * 12)),
    { emailFingerprint: 'email-abuse', networkFingerprint: 'network-other' },
  );
  assert(email7d.some((decision) => decision.target === 'email' && decision.duration === '7d'), 'Email should auto-block for 7d after 6 abusive incidents in 7 days.');

  const emailPermanent = automaticBlockDecision(
    Array.from({ length: 12 }, (_, index) => abuseEvent(index, index * 36)),
    { emailFingerprint: 'email-abuse', networkFingerprint: 'network-other' },
  );
  assert(emailPermanent.some((decision) => decision.target === 'email' && decision.duration === 'permanent'), 'Email should auto-block permanently after 12 abusive incidents in 30 days.');

  const network24h = automaticBlockDecision(
    Array.from({ length: 6 }, (_, index) => abuseEvent(index, index)),
    { emailFingerprint: 'other-email', networkFingerprint: 'network-abuse' },
  );
  assert(network24h.some((decision) => decision.target === 'network' && decision.duration === '24h'), 'Network should auto-block for 24h after 6 abusive incidents in 24 hours.');

  const notSpamEvents = [
    abuseEvent(1, 0, { verdict: 'not_spam', reviewedAt: new Date().toISOString(), reviewedBy: 'admin@example.com' }),
    abuseEvent(2, 1, { verdict: 'not_spam', reviewedAt: new Date().toISOString(), reviewedBy: 'admin@example.com' }),
    abuseEvent(3, 2, { verdict: 'not_spam', reviewedAt: new Date().toISOString(), reviewedBy: 'admin@example.com' }),
  ];
  const notSpamDecision = automaticBlockDecision(
    notSpamEvents,
    { emailFingerprint: 'email-abuse', networkFingerprint: 'network-abuse' },
  );
  assert(notSpamDecision.length === 0, 'Not-spam reviews must be excluded from automatic escalation.');

  console.log('PASS | verified-submission velocity limit detected');
  console.log('PASS | automatic email 24h escalation');
  console.log('PASS | automatic email 7d escalation');
  console.log('PASS | automatic email permanent escalation');
  console.log('PASS | automatic network 24h escalation');
  console.log('PASS | not-spam review excluded from escalation');
}

await run();
