// Fixed, non-sensitive CI diagnostic vocabulary. Never copy server messages into evidence.
// Canonical static identifiers originate from healthComponents() in system-health.ts.
// Add any new inventory IDs deliberately; never trust dynamic check identifiers.
const KNOWN_CHECK_IDS=new Set(["account-profile-api","account-security-api","action-center","admin-home","admin-session","auth-security-api","blog-admin","blog-api","business-crm","business-crm-api","business-crm-startup","calendar-api","calendar-office365-api","credential-github","credential-microsoft-graph","credential-netlify","credential-quickbooks","credential-signwell","credential-turnstile","custom-roles-api","dark-mode-qa","email-activity-api","email-admin","email-delivery","email-logo","email-monitoring-access","email-preview","email-preview-api","email-release-sync","email-routing-api","email-send-access","email-template-compatibility","event-ops","event-ops-api","gallery","gallery-api","insurance","local-seo","login-alert-policy","master-calendar","mobile-bar-workforce","mobile-bar-workforce-api","netlify-github-sync","netlify-recovery-credential","payroll","payroll-api","quickbooks","quickbooks-api","quickbooks-tax-invariant","resend-webhook","sales-crm","sales-crm-api","security","security-api","seo-api","signwell-signed-pdf","signwell-webhook-delivery","signwell-webhook-registration","staff-api","staff-availability-api","staff-directory-api","staff-home","staff-management","synthetic-event-documents","synthetic-quickbooks-webhook","synthetic-signwell-webhook","synthetic-vendor-insurance-document","system-health","system-health-api","turnstile-hostname-action","turnstile-infrastructure-events","turnstile-secret","turnstile-site-key","turnstile-siteverify","turnstile-validation-history","turnstile-widgets","vendor-crm","vendor-crm-api","vendor-insurance-api","wedding-profitability","wedding-profitability-api","workspace-alerts-api"]);
const RULES=[
  [/^(netlify|deploy|release|production|github|build|recovery)/,'deployment','HEALTH_DEPLOYMENT_FAILED'],
  [/^(qbo|quickbooks|accounting|invoice|tax|payment)/,'accounting','HEALTH_ACCOUNTING_FAILED'],
  [/^(turnstile|bot|captcha)/,'security','HEALTH_SECURITY_FAILED'],
  [/^(auth|identity|session|credential|oauth)/,'identity','HEALTH_IDENTITY_FAILED'],
  [/^(dark-mode|visual|theme|responsive|browser|screenshot)/,'visual-qa','HEALTH_VISUAL_QA_FAILED'],
  [/^(mail|email|resend|office365|calendar|signwell|synthetic)/,'integration','HEALTH_INTEGRATION_FAILED'],
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
    if(!id||!KNOWN_CHECK_IDS.has(id)||seen.has(id))continue;
    seen.add(id);
    const match=RULES.find(([re])=>re.test(id));
    result.push({id,category:match?.[1]||'other',errorCode:match?.[2]||'HEALTH_CHECK_FAILED'});
    if(result.length===100)break;
  }
  // A count mismatch is not evidence of success: caller retains authoritative failed count.
  return result.slice(0,Math.max(0,Number.isSafeInteger(authoritativeFailed)?authoritativeFailed:0));
}


export function sanitizeFailedHealthIds(failedIds,authoritativeFailed){
  if(!Number.isSafeInteger(authoritativeFailed)||authoritativeFailed<=0||!Array.isArray(failedIds)
    ||failedIds.length!==authoritativeFailed)return [];
  const result=[],seen=new Set();
  for(const raw of failedIds){
    const id=typeof raw==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(raw)?raw:null;
    if(!id||!KNOWN_CHECK_IDS.has(id)||seen.has(id))return [];
    seen.add(id);
    const match=RULES.find(([re])=>re.test(id));
    result.push({id,category:match?.[1]||'other',errorCode:match?.[2]||'HEALTH_CHECK_FAILED'});
  }
  return result;
}
