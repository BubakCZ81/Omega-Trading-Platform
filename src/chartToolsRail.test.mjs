import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSidebar } from '@luxalgo/vela/plugin';
import {
  chartSidebarLayout,
  dockChartSidebarOnDrawingRail,
  placeMarketFlowButtonsAfterTradingPanel,
} from './chartToolsRail.ts';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

function sidebarEntries(groups) {
  return groups.flatMap(group => group.map(entry => entry.id));
}

class Element {
  dataset = {};
  children = [];
  parentElement = null;
  id = '';
  nextElementSibling = null;

  append(child) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter(item => item !== child);
    }
    this.children.push(child);
    child.parentElement = this;
    this.updateSiblings();
  }

  insertBefore(child, reference) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter(item => item !== child);
      child.parentElement.updateSiblings();
    }
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentElement = this;
    this.updateSiblings();
  }

  updateSiblings() {
    this.children.forEach((child, index) => {
      child.nextElementSibling = this.children[index + 1] ?? null;
    });
  }

  querySelector(selector) {
    return this.selectors?.[selector] ?? null;
  }

  querySelectorAll(selector) {
    return this.selectors?.[selector] ?? [];
  }
}

test('Vela composes Data Window in the bottom section after sidebar actions', () => {
  const sources = [
    { id: 'omega-time-sales', kind: 'panel' },
    { id: 'omega-dom', kind: 'panel' },
    { id: 'objects', kind: 'panel' },
    { id: 'omega-auto-upper-trendline', kind: 'action', order: 12 },
    { id: 'omega-auto-lower-trendline', kind: 'action', order: 13 },
    { id: 'dataWindow', kind: 'panel' },
  ];
  const result = composeSidebar(sources, chartSidebarLayout);

  assert.deepEqual(sidebarEntries(result.top), [
    'omega-time-sales',
    'omega-dom',
    'objects',
    'omega-auto-upper-trendline',
    'omega-auto-lower-trendline',
  ]);
  assert.deepEqual(sidebarEntries(result.bottom), ['dataWindow']);
});

test('sidebar panel launchers override generic draggable-panel positioning', () => {
  const panelOverride = styles.match(/\.vela-sidebar-btn\[data-panel-id\]\s*\{([^}]*)\}/)?.[1];
  assert.ok(panelOverride);
  assert.match(panelOverride, /position:\s*relative\s*!important/);
  assert.match(panelOverride, /z-index:\s*auto\s*!important/);
  assert.match(panelOverride, /box-shadow:\s*none\s*!important/);
  assert.match(styles, /\.vela-sidebar-btn\[data-panel-id\]:hover\s*\{[^}]*box-shadow:\s*none\s*!important/);
});

test('moves the existing sidebar into the drawing rail without duplicating it', () => {
  const host = new Element();
  const drawingRail = new Element();
  const sidebar = new Element();
  const oldSidebarHost = new Element();
  oldSidebarHost.append(sidebar);
  host.selectors = {
    '.vela-ws-toolbar': drawingRail,
    '.vela-sidebar': sidebar,
  };

  assert.equal(dockChartSidebarOnDrawingRail(host), true);
  assert.equal(sidebar.parentElement, drawingRail);
  assert.deepEqual(drawingRail.children, [sidebar]);
  assert.equal(drawingRail.dataset.omegaToolsRail, 'left');

  assert.equal(dockChartSidebarOnDrawingRail(host), true);
  assert.deepEqual(drawingRail.children, [sidebar]);
});

test('reports when the chart rail or sidebar is unavailable', () => {
  assert.equal(dockChartSidebarOnDrawingRail(new Element()), false);
});

test('places Trading Panel, Object Tree, Time & Sales, and Depth buttons before Alerts', () => {
  const host = new Element();
  const topbar = new Element();
  const right = new Element();
  const tradingPanel = new Element();
  tradingPanel.id = 'vela-tool-vela-widget-panel-omega-trading-panel';
  const actions = new Element();
  const alerts = new Element();
  alerts.id = 'vela-tool-vela-widget-alerts';
  const panels = new Element();
  const dataWindow = new Element();
  dataWindow.id = 'vela-tool-vela-widget-panel-dataWindow';
  const objects = new Element();
  objects.id = 'vela-tool-vela-widget-panel-objects';
  const timeSales = new Element();
  timeSales.id = 'vela-tool-vela-widget-panel-omega-time-sales';
  const depth = new Element();
  depth.id = 'vela-tool-vela-widget-panel-omega-dom';
  const screenshot = new Element();

  right.append(actions);
  right.append(alerts);
  right.append(panels);
  right.append(screenshot);
  panels.append(dataWindow);
  panels.append(tradingPanel);
  panels.append(objects);
  panels.append(timeSales);
  panels.append(depth);
  topbar.selectors = {
    '.vela-topbar-right': right,
  };
  right.selectors = {
    '.vela-widget-actions': actions,
    '#vela-tool-vela-widget-alerts': alerts,
  };
  topbar.querySelector = selector => {
    if (selector === '#vela-tool-vela-widget-panel-omega-trading-panel') return tradingPanel;
    if (selector === '#vela-tool-vela-widget-panel-objects') return objects;
    if (selector === '#vela-tool-vela-widget-panel-omega-time-sales') return timeSales;
    if (selector === '#vela-tool-vela-widget-panel-omega-dom') return depth;
    return topbar.selectors?.[selector] ?? null;
  };
  host.selectors = { '.vela-widget-topbar': [topbar] };

  assert.equal(placeMarketFlowButtonsAfterTradingPanel(host), 4);
  assert.deepEqual(right.children, [actions, tradingPanel, objects, timeSales, depth, alerts, panels, screenshot]);
  assert.deepEqual(panels.children, [dataWindow]);
  assert.equal(placeMarketFlowButtonsAfterTradingPanel(host), 0);
  assert.deepEqual(right.children, [actions, tradingPanel, objects, timeSales, depth, alerts, panels, screenshot]);
});

test('hides only the moved panel launchers from the left rail', () => {
  assert.match(styles, /\.vela-sidebar-btn\[data-panel-id="omega-trading-panel"\][\s\S]*display:\s*none\s*!important/);
  assert.match(styles, /\.vela-sidebar-btn\[data-panel-id="objects"\][\s\S]*display:\s*none\s*!important/);
  assert.match(styles, /\.vela-sidebar-btn\[data-panel-id="omega-time-sales"\][\s\S]*display:\s*none\s*!important/);
  assert.match(styles, /\.vela-sidebar-btn\[data-panel-id="omega-dom"\][\s\S]*display:\s*none\s*!important/);
});
