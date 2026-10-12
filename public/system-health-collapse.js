(() => {
  const page = document.querySelector('main[data-system-health-page]');
  if (!(page instanceof HTMLElement)) return;

  const desktopQuery = window.matchMedia('(min-width: 768px)');

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
      if (label) label.textContent = critical ? 'Critical · Open' : nextCollapsed ? 'Expand' : 'Collapse';
    }
  }

  function syncSection(section, { initial = false } = {}) {
    if (!(section instanceof HTMLElement) || section.dataset.mobileCollapsible !== 'true') return;
    const critical = section.dataset.healthSectionStatus === 'red';

    if (critical) {
      section.dataset.koaCriticalAutoOpen = 'true';
      setCollapsed(section, false);
      return;
    }

    if (initial || section.dataset.koaCriticalAutoOpen === 'true') {
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

    const toggle = section.querySelector('[data-mobile-collapse-toggle]');
    if (toggle instanceof HTMLButtonElement) {
      toggle.addEventListener('click', (event) => {
        if (!desktopQuery.matches) return;
        event.stopPropagation();
        setCollapsed(section, section.dataset.mobileCollapsed !== 'true');
      });
    }

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
    attributeFilter: ['data-health-section-status', 'data-mobile-collapsible'],
  });

  desktopQuery.addEventListener?.('change', () => syncAll({ initial: desktopQuery.matches }));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => syncAll({ initial: true }), { once: true });
  } else {
    syncAll({ initial: true });
  }
})();
