#!/usr/bin/env node
// Dependency-free execution of the actual controller against a bounded DOM fixture.
// The real Chromium/WebKit viewport and interaction release gates remain mandatory.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/system-health-collapse.js', import.meta.url), 'utf8');

function fixture({ desktop = false, initialStatus = 'green' } = {}) {
  const observers = [];
  const datasetName = (key) => 'data-' + String(key).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
  function record(mutation) {
    for (const observer of observers) {
      if (!observer.root) continue;
      let target = mutation.target;
      while (target && target !== observer.root) target = target.parentElement;
      if (!target) continue;
      if (mutation.type === 'attributes'
          && !observer.options.attributeFilter.includes(mutation.attributeName)) continue;
      observer.records.push(mutation);
    }
  }
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this._text = '';
      this.textWrites = 0;
      this.dataset = new Proxy({}, {
        get: (_, key) => this.attributes.get(datasetName(key)),
        set: (_, key, value) => { this.setAttribute(datasetName(key), String(value)); return true; },
        deleteProperty: (_, key) => { this.attributes.delete(datasetName(key)); return true; },
      });
      const classes = new Set();
      this.classList = {
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const add = force === undefined ? !classes.has(name) : force;
          if (add) classes.add(name); else classes.delete(name);
          return add;
        },
      };
    }
    get firstElementChild() { return this.children[0] || null; }
    get textContent() { return this._text; }
    set textContent(value) {
      // DOM textContent replacement emits childList even for identical text.
      this._text = String(value);
      this.textWrites++;
      record({ type: 'childList', target: this, addedNodes: [{ nodeType: 3 }], removedNodes: [] });
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      record({ type: 'attributes', target: this, attributeName: name, addedNodes: [] });
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      record({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
      return child;
    }
    querySelectorAll(selector) {
      const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
      assert.ok(attr, 'Unexpected selector in controller fixture: ' + selector);
      return this.children.flatMap((child) => [
        ...(child.hasAttribute(attr) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selectors) {
      for (let target = this; target; target = target.parentElement) {
        if (selectors.split(',').includes(target.tagName)) return target;
      }
      return null;
    }
    addEventListener(name, listener) {
      const handlers = this.listeners.get(name) || [];
      handlers.push(listener);
      this.listeners.set(name, handlers);
    }
    click() {
      if (this.disabled) return;
      const event = { target: this };
      for (let target = this; target; target = target.parentElement) {
        for (const listener of target.listeners.get('click') || []) listener(event);
      }
    }
  }
  class Button extends Element { constructor() { super('button'); this.disabled = false; } }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
    observe(root, options) { this.root = root; this.options = options; }
  }
  const page = new Element('main');
  const section = page.appendChild(new Element('section'));
  section.dataset.mobileCollapsible = 'true';
  section.dataset.healthSectionStatus = initialStatus;
  const header = section.appendChild(new Element('header'));
  const button = header.appendChild(new Button());
  button.setAttribute('data-mobile-collapse-toggle', '');
  const label = button.appendChild(new Element('span'));
  label.setAttribute('data-health-toggle-label', '');
  const detail = section.appendChild(new Element());
  // Model the existing page-owned toggle handler. The controller must not add a second one.
  button.addEventListener('click', () => {
    const collapsed = section.dataset.mobileCollapsed !== 'true';
    section.dataset.mobileCollapsed = String(collapsed);
    detail.classList.toggle('koa-mobile-collapsed-content', collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
    label.textContent = collapsed ? 'Expand' : 'Collapse';
  });
  const media = { matches: desktop, addEventListener() {} };
  const document = {
    readyState: 'complete',
    head: new Element('head'),
    querySelector(selector) { assert.equal(selector, 'main[data-system-health-page]'); return page; },
    createElement: (tag) => new Element(tag),
  };
  runInNewContext(source, {
    document, window: { matchMedia: () => media },
    HTMLElement: Element, Element, HTMLButtonElement: Button, MutationObserver,
  }, { filename: 'system-health-collapse.js', timeout: 1000 });
  function flush() {
    let deliveries = 0;
    while (observers.some((observer) => observer.records.length)) {
      assert.ok(++deliveries <= 25,
        'Accordion MutationObserver did not settle: repeated label writes starve the browser event loop.');
      for (const observer of observers) {
        if (!observer.records.length) continue;
        const batch = observer.records.splice(0);
        observer.callback(batch);
      }
    }
    return deliveries;
  }
  return { page, section, header, button, label, detail, flush };
}

let scenarios = 0;
for (const desktop of [false, true]) {
  const f = fixture({ desktop });
  f.flush();
  assert.equal(f.section.dataset.mobileCollapsed, 'true');
  assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.button.listeners.get('click').length, 1, 'Do not duplicate the page-owned toggle listener.');
  f.button.click(); f.flush();
  assert.equal(f.section.dataset.mobileCollapsed, 'false');
  assert.equal(f.detail.classList.contains('koa-mobile-collapsed-content'), false);
  f.button.click(); f.flush();
  assert.equal(f.section.dataset.mobileCollapsed, 'true');
  f.section.dataset.healthSectionStatus = 'red'; f.flush();
  assert.equal(f.section.dataset.mobileCollapsed, 'false');
  assert.equal(f.button.disabled, true);
  assert.equal(f.button.getAttribute('aria-expanded'), 'true');
  const writes = f.label.textWrites;
  for (let index = 0; index < 10; index++) {
    f.section.dataset.healthSectionStatus = 'red';
    f.detail.appendChild(new (f.detail.constructor)());
    f.flush();
    f.header.click(); f.flush();
    assert.equal(f.section.dataset.mobileCollapsed, 'false');
  }
  assert.equal(f.label.textWrites, writes, 'Unchanged critical labels must not be replaced.');
  f.button.click(); f.flush();
  assert.equal(f.section.dataset.mobileCollapsed, 'false');
  f.section.dataset.healthSectionStatus = 'green'; f.flush();
  assert.equal(f.section.dataset.mobileCollapsed, 'true');
  assert.equal(f.button.disabled, false);
  f.button.click(); f.flush();
  f.detail.appendChild(new (f.detail.constructor)()); f.flush();
  assert.equal(f.section.dataset.mobileCollapsed, 'false', 'Unrelated render mutations must preserve manual expansion.');
  const initiallyCritical = fixture({ desktop, initialStatus: 'red' });
  initiallyCritical.flush();
  assert.equal(initiallyCritical.section.dataset.mobileCollapsed, 'false');
  assert.equal(initiallyCritical.button.disabled, true);
  scenarios += 9;
}
console.log('PASS | ' + scenarios + ' controller runtime scenarios: bounded observer delivery, critical open/recovery, single listener, manual state.');
