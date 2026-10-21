/* Progressive enhancement: keep the renderer and threshold-save contract intact. */
(() => {
  const grid = document.querySelector('[data-credential-reliability-grid]');
  if (!(grid instanceof HTMLElement) || grid.dataset.credentialCardsReady === 'true') return;
  const panel = grid.parentElement;
  if (!(panel instanceof HTMLElement)) return;
  grid.dataset.credentialCardsReady = 'true';
  panel.dataset.credentialLayout = '';
  // Per-page disclosure preferences only; never persist credentials or health data.
  const expandedProviders = new Map();
  let nextId = 0;
  const style = document.createElement('style');
  style.dataset.credentialReliabilityStyles = '';
  style.textContent = `
    [data-credential-layout] { container: credential-panel / inline-size; }
    [data-credential-layout] > :first-child { align-items: flex-start; gap: 1rem; }
    [data-credential-layout] > :first-child > :first-child { min-width: 0; flex: 1; }
    [data-credential-layout] > :first-child > :last-child { flex-shrink: 0; }
    [data-credential-layout] [data-save-credential-thresholds] {
      min-height: 44px; white-space: nowrap; font-size: .75rem; line-height: 1.4;
    }
    [data-credential-reliability-note] { max-width: 80ch; color: var(--koa-text-muted); font-size: .8125rem; line-height: 1.65; }
    [data-credential-reliability-grid] { display: block; margin-top: 1.5rem; }
    [data-credential-provider-group] + [data-credential-provider-group] { margin-top: 1.5rem; }
    [data-credential-provider-heading] {
      margin: 0 0 .75rem; color: var(--koa-text-strong); font-size: .875rem; font-weight: 700;
    }
    [data-credential-provider-grid] { display: grid; grid-template-columns: minmax(0,1fr); gap: 1rem; align-items: start; }
    [data-credential-provider] { min-width: 0; padding: 1.125rem; align-self: start; }
    [data-credential-overview] { min-width: 0; container: credential-overview / inline-size; }
    [data-credential-card-header] { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: .75rem; }
    [data-credential-card-header] > div { flex: 1 1 9rem; min-width: 0; }
    [data-credential-card-header] h4 { font-size: 1rem; line-height: 1.5; overflow-wrap: anywhere; }
    [data-credential-card-header] p { color: var(--koa-text-muted); font-size: .75rem; line-height: 1.5; }
    [data-credential-card-header] > span { font-size: .625rem; line-height: 1.5; }
    [data-credential-periods] { display: grid; grid-template-columns: minmax(0,1fr); gap: .625rem; margin-top: 1rem; }
    [data-credential-periods] > div {
      display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center;
      min-width: 0; gap: .25rem .5rem; padding: .75rem; text-align: left;
    }
    [data-credential-periods] > div > :first-child { font-size: .6875rem; }
    [data-credential-periods] strong {
      margin: 0; font-size: 1.375rem; line-height: 1.35; font-variant-numeric: tabular-nums;
      letter-spacing: -.025em; white-space: nowrap;
    }
    [data-credential-periods] > div > :last-child {
      grid-column: 1 / -1; margin: 0; color: var(--koa-text-muted); font-size: .75rem; line-height: 1.5; overflow-wrap: anywhere;
    }
    [data-credential-provider-details] { min-width: 0; }
    [data-credential-provider-details][hidden] { display: none !important; }
    [data-credential-threshold-controls] { margin-top: 1rem; gap: .875rem; }
    [data-credential-threshold-controls] label { min-width: 0; font-size: .6875rem; line-height: 1.6; }
    [data-credential-threshold-controls] input {
      box-sizing: border-box; min-width: 0; min-height: 44px; font-size: 1rem; line-height: 1.5;
    }
    [data-credential-provider-details] > p { font-size: .8125rem; line-height: 1.6; overflow-wrap: anywhere; }
    [data-credential-provider-toggle] {
      display: flex; align-items: center; justify-content: space-between; gap: .75rem;
      width: 100%; min-height: 44px; margin-top: 1rem; padding: .625rem .75rem;
      border: 1px solid var(--koa-line); border-radius: .75rem;
      background: var(--koa-surface); color: var(--koa-text-strong);
      font: inherit; font-size: .8125rem; font-weight: 650; line-height: 1.5; text-align: left;
      cursor: pointer;
    }
    [data-credential-provider-toggle]:focus-visible {
      outline: 3px solid var(--koa-accent-text); outline-offset: 3px;
    }
    @container credential-overview (min-width: 19rem) {
      [data-credential-periods] { grid-template-columns: repeat(3,minmax(0,1fr)); }
      [data-credential-periods] > div { display: block; text-align: center; padding: .75rem .5rem; }
      [data-credential-periods] strong { margin: .5rem 0; }
    }
    @container credential-panel (min-width: 44rem) {
      [data-credential-provider-group="healthy"] > [data-credential-provider-grid] { grid-template-columns: repeat(2,minmax(0,1fr)); }
      [data-credential-provider-group]:not([data-credential-provider-group="healthy"]) [data-credential-provider] {
        display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 1.5rem;
      }
      [data-credential-provider-group]:not([data-credential-provider-group="healthy"]) [data-credential-threshold-controls] { margin-top: 0; }
    }
    @container credential-panel (min-width: 66rem) {
      [data-credential-provider-group="healthy"] > [data-credential-provider-grid] { grid-template-columns: repeat(3,minmax(0,1fr)); }
    }
    @media (max-width: 639px) {
      [data-credential-layout] > :first-child { flex-direction: column; }
      [data-credential-layout] > :first-child > :last-child { width: 100%; }
      [data-credential-layout] [data-save-credential-thresholds] { width: 100%; }
    }
  `;
  document.head.appendChild(style);
  const message = panel.querySelector('[data-credential-threshold-message]');
  if (message) {
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
  }

  function enhance(card) {
    if (card.hasAttribute('data-credential-provider')) return;
    const parts = [...card.children];
    const [top, metrics, controls] = parts;
    const input = card.querySelector('[data-credential-threshold-yellow]');
    const title = card.querySelector('h4');
    // Unknown markup stays fully visible instead of silently hiding a failure.
    if (parts.length !== 6 || !input || !title || !controls.contains(input)) return;
    const key = input.dataset.credentialThresholdYellow;
    const severity = card.classList.contains('bg-red-50') ? 'red'
      : card.classList.contains('bg-amber-50') ? 'yellow'
      : card.classList.contains('bg-emerald-50') ? 'green' : 'insufficient';
    card.dataset.credentialProvider = key;
    card.dataset.credentialSeverity = severity;
    top.dataset.credentialCardHeader = '';
    metrics.dataset.credentialPeriods = '';
    controls.dataset.credentialThresholdControls = '';
    const overview = document.createElement('div');
    overview.dataset.credentialOverview = '';
    overview.append(top, metrics);
    const details = document.createElement('div');
    details.dataset.credentialProviderDetails = '';
    details.id = 'credential-provider-details-' + (++nextId);
    details.append(...parts.slice(2));
    card.replaceChildren(overview, details);
    if (severity !== 'green') return; // Warnings, failures and building history never collapse.

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.dataset.credentialProviderToggle = '';
    toggle.setAttribute('aria-controls', details.id);
    const label = document.createElement('span');
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    toggle.append(label, icon);
    function setExpanded(expanded) {
      details.hidden = !expanded;
      toggle.setAttribute('aria-expanded', String(expanded));
      label.textContent = expanded ? 'Hide details and thresholds' : 'Show details and thresholds';
      toggle.setAttribute('aria-label', label.textContent + ' for ' + title.textContent);
      icon.textContent = expanded ? '\u2212' : '+';
    }
    setExpanded(expandedProviders.get(key) === true);
    toggle.addEventListener('click', () => {
      const expanded = details.hidden;
      expandedProviders.set(key, expanded);
      setExpanded(expanded);
    });
    overview.appendChild(toggle);
  }

  function sync() {
    const cards = [...grid.querySelectorAll('article')];
    if (!cards.length || cards.every((card) => card.hasAttribute('data-credential-provider'))) return;
    observer.disconnect();
    try {
      cards.forEach(enhance);
      const severityOrder = { red: 0, yellow: 1, insufficient: 2, green: 3 };
      cards.sort((a, b) => (severityOrder[a.dataset.credentialSeverity] ?? 2) - (severityOrder[b.dataset.credentialSeverity] ?? 2));
      const groups = [
        ['attention', 'Needs attention', cards.filter((card) => ['red', 'yellow'].includes(card.dataset.credentialSeverity))],
        ['building', 'Building history', cards.filter((card) => !['red', 'yellow', 'green'].includes(card.dataset.credentialSeverity))],
        ['healthy', 'Healthy providers', cards.filter((card) => card.dataset.credentialSeverity === 'green')],
      ];
      const fragment = document.createDocumentFragment();
      for (const [key, label, members] of groups) {
        if (!members.length) continue;
        const group = document.createElement('section');
        group.dataset.credentialProviderGroup = key;
        group.setAttribute('aria-label', label);
        const heading = document.createElement('p');
        heading.dataset.credentialProviderHeading = '';
        heading.textContent = label + ' (' + members.length + ')';
        const list = document.createElement('div');
        list.dataset.credentialProviderGrid = '';
        list.append(...members);
        group.append(heading, list);
        fragment.appendChild(group);
      }
      // Move, never clone/remove, editable inputs. The existing save action still
      // queries every provider, including inputs inside collapsed healthy cards.
      grid.replaceChildren(fragment);
    } finally {
      observer.observe(grid, { childList: true });
    }
  }
  // Observe only renderer replacements, not our own toggles or text changes.
  const observer = new MutationObserver(sync);
  observer.observe(grid, { childList: true });
  sync();
})();
