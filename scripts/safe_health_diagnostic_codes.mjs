// Fixed, non-sensitive CI diagnostic vocabulary. Never copy server messages into evidence.
const RULES=[
  [/^(netlify|deploy|release|production|github|build|recovery)/,'deployment','HEALTH_DEPLOYMENT_FAILED'],
  [/^(qbo|quickbooks|accounting|invoice|tax|payment)/,'accounting','HEALTH_ACCOUNTING_FAILED'],
  [/^(turnstile|bot|captcha)/,'security','HEALTH_SECURITY_FAILED'],
  [/^(auth|identity|session|credential|oauth)/,'identity','HEALTH_IDENTITY_FAILED'],
  [/^(visual|theme|responsive|browser|screenshot)/,'visual-qa','HEALTH_VISUAL_QA_FAILED'],
  [/^(mail|email|resend|office365|calendar)/,'integration','HEALTH_INTEGRATION_FAILED'],
];
export function sanitizeFailedHealthChecks(checks,authoritativeFailed){
  if(!Array.isArray(checks))return [];
  const result=[],seen=new Set();
  for(const row of checks){
    if(row?.ok!==false&&row?.severity!=='red')continue;
    const raw=typeof row?.id==='string'?row.id:'';
    // Identifiers are diagnostic metadata, not safe until allowlisted by shape.
    // Never publish arbitrary labels, details, paths, emails or backend exception codes.
    const id=/^[a-z][a-z0-9-]{0,63}$/.test(raw)?raw:null;
    if(!id||seen.has(id))continue;
    seen.add(id);
    const match=RULES.find(([re])=>re.test(id));
    result.push({id,category:match?.[1]||'other',errorCode:match?.[2]||'HEALTH_CHECK_FAILED'});
    if(result.length===100)break;
  }
  // A count mismatch is not evidence of success: caller retains authoritative failed count.
  return result.slice(0,Math.max(0,Number.isSafeInteger(authoritativeFailed)?authoritativeFailed:0));
}
