/**
 * Conservative, independently testable production deployment identity checks.
 * A GitHub workflow dispatch is permitted only for the exact published main SHA.
 */
export const KoaRepo = 'AstroTat808/koasevents.com';
const HEX40 = /^[0-9a-f]{40}$/;
export function eligibleProductionDeploy({context,deployId,commitRef,mainSha}) {
  return context === 'production' &&
    typeof deployId === 'string' && /^[a-z0-9]{12,80}$/i.test(deployId) &&
    typeof commitRef === 'string' && HEX40.test(commitRef) &&
    typeof mainSha === 'string' && HEX40.test(mainSha) &&
    commitRef === mainSha;
}
export function sanitizedDeployFailure({context,deployId,commitRef,at}) {
  if (context !== 'production' || typeof deployId !== 'string' || !/^[a-z0-9]{12,80}$/i.test(deployId)) return null;
  return {
    deployId,commit:/^[0-9a-f]{40}$/.test(commitRef || '') ? commitRef : 'unverified',
    at:typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : new Date().toISOString(),
    projectUrl:'https://app.netlify.com/projects/koasevents-website',
  };
}
