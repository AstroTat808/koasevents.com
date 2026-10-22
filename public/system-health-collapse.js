(() => {
  const page = document.querySelector('main[data-system-health-page]');
  if (!(page instanceof HTMLElement)) return;

  const desktopQuery = window.matchMedia('(min-width: 768px)');

  const style = document.createElement('style');
  style.dataset.koaSystemHealthCollapseStyles = '';
  style.textContent = `
    @media (min-width: 768px) {
      body.koa-admin-page main[data-system-health-page] .koa-mobile-collapsed-content {
        display: none !important;
      }
      body.koa-admin-page main[data-system-health-page] .health-section-mobile-controls {
        display: flex !important;
        flex-wrap: wrap;
        align-items: center;
        gap: .45rem;
        margin-top: .7rem;
      }
      body.koa-admin-page main[data-system-health-page] .health-mobile-detail-toggle {
        display: inline-flex !important;
        min-height: 2.4rem;
        align-items: center;
        justify-content: center;
        margin-top: 0;
        gap: .35rem;
        border: 1px solid var(--koa-line);
        border-radius: 9999px;
        background: var(--koa-surface);
        padding: .55rem .8rem;
        color: var(--koa-forest);
        font-size: .56rem;
        font-weight: 900;
        letter-spacing: .07em;
        line-height: 1.1;
        text-transform: uppercase;
      }
      body.koa-admin-page main[data-system-health-page] .health-section-mobile-summary {
        display: block;
        flex: 1 0 100%;
        width: 100%;
        min-height: 2.2rem;
        margin: .05rem 0 0;
        overflow: hidden;
        border: 0;
        border-radius: .55rem;
        background: transparent;
        padding: .32rem .2rem;
        color: color-mix(in srgb, var(--koa-ink) 64%, transparent);
        font-size: .72rem;
        font-weight: 650;
        line-height: 1.35;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
      }
      body.koa-admin-page main[data-system-health-page] [data-mobile-collapsed="false"] .health-section-mobile-summary {
        display: none !important;
      }
      body.koa-admin-page main[data-system-health-page] .health-section-mobile-header {
        cursor: pointer;
      }
    }
  `;
  document.head.appendChild(style);

  function sectionContent(section) {
    return [...section.children].filter((child, index) =>
      index > 0 &&
      !(child instanceof HTMLButtonElement && child.hasAttribute('data-mobile-collapse-toggle'))
    );
  }

  function setCollapsed(section, collapsed) {
    if (!(section instanceof HTMLElement)) return;
    const critical = section.dataset.healthSectionStatus === 'red';
    const nextCollapsed = critical ? false : Boolean(collapsed);

    sectionContent(section).forEach((child) => {
      child.classList.toggle('koa-mobile-collapsed-content', nextCollapsed);
    });
    section.dataset.mobileCollapsed = nextCollapsed ? 'true' : 'false';

    const toggle = section.querySelector('[data-mobile-collapse-toggle]');
    if (toggle instanceof HTMLButtonElement) {
      toggle.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
      toggle.disabled = critical;
      const label = toggle.querySelector('[data-health-toggle-label]');
      const nextLabel = critical ? 'Critical · Open' : nextCollapsed ? 'Expand' : 'Collapse';
      // textContent replacement queues childList even when the string is unchanged.
      // This controller observes those mutations, so repeated writes would keep
      // critical sections in an endless microtask loop and starve input/paint.
      if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
    }
  }

  function syncSection(section, { initial = false } = {}) {
    if (!(section instanceof HTMLElement) || section.dataset.mobileCollapsible !== 'true') return;
    // Astro can initialize native section controls after this external script.
    // Initialize each section once when its controls actually exist, not only
    // during the document-wide startup pass. Later renders preserve user state.
    const firstSync = section.dataset.koaCollapseInitialized !== 'true';
    if (firstSync && !section.querySelector('[data-mobile-collapse-toggle]')) return;
    const critical = section.dataset.healthSectionStatus === 'red';
    section.dataset.koaCollapseInitialized = 'true';

    if (critical) {
      section.dataset.koaCriticalAutoOpen = 'true';
      setCollapsed(section, false);
      return;
    }

    if (initial || firstSync || section.dataset.koaCriticalAutoOpen === 'true') {
      delete section.dataset.koaCriticalAutoOpen;
      setCollapsed(section, true);
    }
  }

  function wireDesktopHeader(section) {
    if (!(section instanceof HTMLElement) || section.dataset.koaDesktopCollapseReady === 'true') return;
    const header = section.firstElementChild;
    if (!(header instanceof HTMLElement)) return;

    header.addEventListener('click', (event) => {
      if (!desktopQuery.matches) return;
      const target = event.target;
      if (target instanceof Element && target.closest('a,button,input,select,textarea,label')) return;
      setCollapsed(section, section.dataset.mobileCollapsed !== 'true');
    });

    // The page's original button listener already handles toggling at every width.
    // Installing a second listener here would immediately reverse each desktop click.

    section.dataset.koaDesktopCollapseReady = 'true';
  }

  function syncAll({ initial = false } = {}) {
    page.querySelectorAll('[data-mobile-collapsible]').forEach((section) => {
      if (!(section instanceof HTMLElement)) return;
      wireDesktopHeader(section);
      syncSection(section, { initial });
    });
  }

  const observer = new MutationObserver((mutations) => {
    let needsSync = false;
    for (const mutation of mutations) {
      if (
        mutation.type === 'attributes' &&
        mutation.target instanceof HTMLElement &&
        mutation.target.dataset.mobileCollapsible === 'true'
      ) {
        syncSection(mutation.target);
      }
      if (mutation.type === 'childList' && mutation.addedNodes.length) needsSync = true;
    }
    if (needsSync) syncAll();
  });

  observer.observe(page, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-health-section-status', 'data-mobile-collapsible', 'data-mobile-collapse-ready'],
  });

  desktopQuery.addEventListener?.('change', () => syncAll({ initial: desktopQuery.matches }));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => syncAll({ initial: true }), { once: true });
  } else {
    syncAll({ initial: true });
  }

  // Load the provider-level controller only on the existing reliability panel.
  // The original section disclosure behavior and listeners remain unchanged.
  if (page.querySelector('[data-credential-reliability-grid]')) {
    void import('/credential-reliability-cards.js');
  }
})();
