import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeBottomPanel } from './bottomPanel.ts';

class FakeElement extends EventTarget {
  constructor(dataset = {}) {
    super();
    this.dataset = dataset;
    this.hidden = false;
    this.attributes = new Map();
    this.focused = false;
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
    };
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { this.focused = true; }
  click() { this.dispatchEvent(new Event('click')); }
}

test('provider panels return to the Data Feeds chooser without closing it', t => {
  const previousDocument = globalThis.document;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const providerPanels = [
    ['mt5', 'mt5-feed-toggle', 'mt5-feed-modal'],
    ['alpaca', 'broker-toggle', 'broker-modal'],
    ['ibkr', 'ibkr-feed-toggle', 'ibkr-feed-modal'],
    ['quantower', 'quantower-feed-toggle', 'quantower-feed-modal'],
    ['ctrader', 'ctrader-feed-toggle', 'ctrader-feed-modal'],
    ['saxo', 'saxo-feed-toggle', 'saxo-feed-modal'],
  ];
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const feedButtons = providerPanels.map(([feed]) => new FakeElement({ localFeed: feed }));
  const backButtons = providerPanels.map(([, , modalId]) => new FakeElement({ feedBack: modalId }));
  const documentTarget = new EventTarget();
  documentTarget.getElementById = getElementById;
  documentTarget.querySelectorAll = selector => selector === '[data-local-feed]' ? feedButtons : backButtons;
  globalThis.document = documentTarget;

  for (const [, triggerId, modalId] of providerPanels) {
    getElementById(triggerId);
    const modal = getElementById(modalId);
    modal.hidden = true;
  }

  initializeBottomPanel({
    mt5Enabled: true,
    alpacaEnabled: true,
    ibkrEnabled: true,
    ctraderEnabled: true,
    saxoEnabled: true,
    onPaperTradingAction: async () => {},
    onChartLiveTrade: async () => {},
  });

  const chooser = getElementById('local-feeds-modal');
  for (let index = 0; index < providerPanels.length; index += 1) {
    const [, , modalId] = providerPanels[index];
    getElementById('local-feeds-toggle').dispatchEvent(new Event('click'));
    feedButtons[index].dispatchEvent(new Event('click'));

    assert.equal(getElementById(modalId).hidden, false);
    assert.equal(chooser.hidden, true);

    backButtons[index].dispatchEvent(new Event('click'));

    assert.equal(getElementById(modalId).hidden, true);
    assert.equal(getElementById(modalId).classList.contains('open'), false);
    assert.equal(getElementById(modalId).attributes.get('aria-hidden'), 'true');
    assert.equal(chooser.hidden, false);
    assert.equal(chooser.attributes.get('aria-hidden'), 'false');
    assert.equal(feedButtons[index].focused, true);
  }
});

test('floating Buy and Sell buttons start live chart previews, not paper trades', async t => {
  const previousDocument = globalThis.document;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const elements = new Map();
  const documentTarget = new EventTarget();
  documentTarget.getElementById = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  documentTarget.querySelectorAll = () => [];
  globalThis.document = documentTarget;

  const liveTrades = [];
  const paperActions = [];
  initializeBottomPanel({
    mt5Enabled: false,
    alpacaEnabled: false,
    ibkrEnabled: false,
    ctraderEnabled: false,
    saxoEnabled: false,
    onPaperTradingAction: async action => { paperActions.push(action); },
    onChartLiveTrade: async side => { liveTrades.push(side); },
  });

  elements.get('paper-trade-buy').click();
  elements.get('paper-trade-sell').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(liveTrades, ['buy', 'sell']);
  assert.deepEqual(paperActions, []);
});