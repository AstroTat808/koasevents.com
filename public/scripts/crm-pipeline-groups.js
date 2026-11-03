/* Client-only, read-only presentation grouping. Customer identity is determined
 * on the server; shared display names never act as identity keys. */
(function (root) {
  'use strict';
  function groupProjects(projects, customers) {
    const directory = new Map((Array.isArray(customers) ? customers : [])
      .filter(customer => customer && customer.id)
      .map(customer => [customer.id, customer]));
    const groups = new Map();
    for (const project of (Array.isArray(projects) ? projects : [])) {
      if (!project || !project.id) continue;
      const matchingCustomer = directory.get(project.customerId);
      const trusted = Boolean(matchingCustomer &&
        Array.isArray(matchingCustomer.recordIds) &&
        matchingCustomer.recordIds.includes(project.id));
      const customer = trusted ? matchingCustomer : null;
      const key = customer ? 'customer:' + customer.id : 'unlinked:' + project.id;
      if (!groups.has(key)) groups.set(key, {
        key,
        customerId: customer?.id || '',
        name: customer?.name || project.customer?.name || 'Unnamed client',
        email: customer?.email || project.customer?.email || '',
        verified: Boolean(customer?.verified),
        needsReview: Boolean(customer?.needsReview) || !customer,
        records: [],
      });
      groups.get(key).records.push(project);
    }
    return [...groups.values()].sort((a, b) =>
      a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }
  function isPipelineProject(project, stage) {
    if (!project) return false;
    // Converted parents remain in the customer directory and activity history.
    return stage === 'converted'
      ? project.stage === 'converted'
      : project.stage !== 'converted';
  }
  root.KoaCrmPipelineGroups = Object.freeze({ groupProjects, isPipelineProject });
})(typeof window !== 'undefined' ? window : globalThis);
