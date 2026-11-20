import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.children = [];
    this.classList = { add() {}, remove() {} };
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  focus() {}
}

test('Alpaca panel saves fixed API credentials and connects without a broker selector', async t => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const elementIds = [
    'broker-modal', 'broker-toggle', 'broker-close', 'broker-setup-note',
    'alpaca-api-key', 'alpaca-api-secret', 'broker-connect', 'broker-save-credentials',
    'broker-refresh', 'broker-disconnect', 'broker-status', 'broker-accounts',
  ];
  const elements = new Map(elementIds.map(id => [id, new FakeElement()]));
  const documentTarget = new EventTarget();
  documentTarget.getElementById = id => elements.get(id) ?? null;
  documentTarget.createElement = () => new FakeElement();
  const savedCredentials = [];
  const connectionRequests = [];
  let credentialsSaved = false;
  globalThis.document = documentTarget;
  globalThis.window = {
    velaBroker: {
      hasSavedAlpacaCredentials: async () => credentialsSaved,
      saveAlpacaCredentials: async credentials => {
        savedCredentials.push(credentials);
        credentialsSaved = true;
        return { configured: true };
      },
      connectReadOnly: async (brokerId, credentials) => {
        connectionRequests.push({ brokerId, credentials });
        return { broker: 'alpaca', fetchedAt: new Date().toISOString(), accounts: [] };
      },
      fetchSnapshot: async () => ({ broker: 'alpaca', fetchedAt: new Date().toISOString(), accounts: [] }),
      disconnect: async () => true,
    },
  };

  await import('./brokerPanel.ts?alpaca-credentials-test');

  const apiKey = elements.get('alpaca-api-key');
  const apiSecret = elements.get('alpaca-api-secret');
  apiKey.value = 'key-id';
  apiSecret.value = 'secret-key';
  elements.get('broker-save-credentials').dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(savedCredentials, [{ apiKey: 'key-id', apiSecret: 'secret-key' }]);
  assert.equal(apiKey.value, '');
  assert.equal(apiSecret.value, '');
  assert.match(elements.get('broker-status').textContent, /encrypted and saved/);
  assert.equal(documentTarget.getElementById('broker-select'), null);

  elements.get('broker-connect').dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(connectionRequests, [{ brokerId: 'alpaca', credentials: { apiKey: '', apiSecret: '' } }]);
  assert.match(elements.get('broker-status').textContent, /Connected to Alpaca/);
});