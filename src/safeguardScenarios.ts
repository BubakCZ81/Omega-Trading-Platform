export interface SafeguardScenario {
  id: string;
  provider: string;
  scenario: string;
  passed: boolean;
  outcome: string;
}

interface ScenarioOrder {
  id: string;
  provider: string;
  environment: 'demo' | 'paper' | 'sandbox' | 'testnet' | 'live';
  account: string;
  side: 'BUY' | 'SELL' | string;
  volume: number;
  notional: number;
  stopLoss?: number;
  quote: { bid: number; ask: number; time: number };
  liveAcknowledgement?: string;
}

interface MockBrokerResult {
  status: 'filled' | 'partial' | 'rejected' | 'unknown' | 'timeout';
  protected?: boolean;
}

const LIVE_TRADING_ACKNOWLEDGEMENT = 'I understand this places real orders with real money';
const NOW = 1_800_000_000_000;

function validateScenarioOrder(order: ScenarioOrder, policy: {
  maxMt5OrderVolume: number;
  maxSdkOrderNotional: number;
  expectedAccount: string;
}): string | null {
  if (order.account !== policy.expectedAccount) return 'account identity changed';
  if (order.side !== 'BUY' && order.side !== 'SELL') return 'invalid side';
  if (order.provider === 'mt5'
    && (!Number.isFinite(order.volume) || order.volume <= 0 || order.volume > policy.maxMt5OrderVolume)) {
    return 'order volume limit exceeded';
  }
  if (!Number.isFinite(order.notional) || order.notional <= 0 || order.notional > policy.maxSdkOrderNotional) {
    return 'order notional limit exceeded';
  }
  if (!Number.isFinite(order.quote.bid) || !Number.isFinite(order.quote.ask)
    || order.quote.bid <= 0 || order.quote.ask < order.quote.bid
    || NOW - order.quote.time > 30_000) return 'quote invalid or stale';
  if (order.stopLoss === undefined || !Number.isFinite(order.stopLoss) || order.stopLoss <= 0) return 'stop-loss required';
  if ((order.side === 'BUY' && order.stopLoss >= order.quote.bid)
    || (order.side === 'SELL' && order.stopLoss <= order.quote.ask)) return 'stop-loss on wrong side';
  if (order.provider === 'alpaca' && order.environment === 'live'
    && order.liveAcknowledgement !== LIVE_TRADING_ACKNOWLEDGEMENT) return 'explicit live acknowledgement required';
  if (!['mt5', 'alpaca'].includes(order.provider)) return 'provider has no SDK order API';
  if (order.provider !== 'mt5') return 'Alpaca manual market orders are handled in the Broker panel outside this protected-order simulation';
  return null;
}

class MockOrderSession {
  constructor(policy: { maxMt5OrderVolume: number; maxSdkOrderNotional: number; expectedAccount: string }) {
    this.policy = policy;
    this.inFlight = false;
    this.journal = new Map<string, 'sent' | 'protected' | 'partial' | 'unknown' | 'rejected' | 'reconciled'>();
    this.mockCalls = 0;
    this.integrityOk = true;
  }

  policy: { maxMt5OrderVolume: number; maxSdkOrderNotional: number; expectedAccount: string };
  inFlight: boolean;
  journal: Map<string, 'sent' | 'protected' | 'partial' | 'unknown' | 'rejected' | 'reconciled'>;
  mockCalls: number;
  integrityOk: boolean;

  async submit(order: ScenarioOrder, broker: () => Promise<MockBrokerResult>): Promise<string> {
    if (!this.integrityOk) return 'journal integrity failed';
    const validation = validateScenarioOrder(order, this.policy);
    if (validation) return validation;
    if (this.inFlight) return 'submission already in progress';
    if (this.journal.has(order.id)) return 'duplicate intent';
    if ([...this.journal.values()].some(status => ['sent', 'partial', 'unknown'].includes(status))) {
      return 'unresolved journal entry blocks submission';
    }
    this.inFlight = true;
    this.journal.set(order.id, 'sent');
    try {
      this.mockCalls += 1;
      const result = await broker();
      const status = result.status === 'filled' && result.protected ? 'protected'
        : result.status === 'rejected' ? 'rejected'
          : result.status === 'partial' ? 'partial'
            : 'unknown';
      this.journal.set(order.id, status);
      return status;
    } finally {
      this.inFlight = false;
    }
  }

  reconcile(id: string): void {
    if (!this.journal.has(id) || !['sent', 'partial', 'unknown'].includes(this.journal.get(id)!)) {
      throw new Error('Only an unresolved journal entry can be reconciled.');
    }
    this.journal.set(id, 'reconciled');
  }
}

function baseOrder(overrides: Partial<ScenarioOrder> = {}): ScenarioOrder {
  return {
    id: 'scenario-1',
    provider: 'mt5',
    environment: 'demo',
    account: '123456@Demo Server',
    side: 'BUY',
    volume: 0.01,
    notional: 100,
    stopLoss: 99,
    quote: { bid: 100, ask: 101, time: NOW },
    ...overrides,
  };
}

async function exercise(
  scenario: string,
  order: ScenarioOrder,
  expected: string,
  broker: () => Promise<MockBrokerResult> = async () => ({ status: 'filled', protected: true }),
  policy = { maxMt5OrderVolume: 0.01, maxSdkOrderNotional: 100, expectedAccount: '123456@Demo Server' },
): Promise<SafeguardScenario> {
  const session = new MockOrderSession(policy);
  const outcome = await session.submit(order, broker);
  return {
    id: scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    provider: order.provider,
    scenario,
    passed: outcome === expected,
    outcome: `${outcome}${session.mockCalls ? ` · mock sends: ${session.mockCalls}` : ' · no send'}`,
  };
}

export async function runSafeguardScenarios(settings = {
  maxMt5OrderVolume: 0.01,
  maxSdkOrderNotional: 100,
}): Promise<SafeguardScenario[]> {
  const policy = { ...settings, expectedAccount: '123456@Demo Server' };
  const run = (scenario: string, order: ScenarioOrder, expected: string, broker?: () => Promise<MockBrokerResult>) =>
    exercise(scenario, order, expected, broker, policy);
  const scenarios: SafeguardScenario[] = [];
  scenarios.push(await run('Valid MT5 protected fill', baseOrder(), 'protected'));
  scenarios.push(await run('Invalid side blocked', baseOrder({ side: 'SHORT' }), 'invalid side'));
  scenarios.push(await run('Missing stop-loss blocked', baseOrder({ stopLoss: undefined }), 'stop-loss required'));
  scenarios.push(await run('Stop-loss on wrong side blocked', baseOrder({ stopLoss: 101 }), 'stop-loss on wrong side'));
  scenarios.push(await run('Stale quote blocked', baseOrder({ quote: { bid: 100, ask: 101, time: NOW - 31_000 } }), 'quote invalid or stale'));
  scenarios.push(await run('Volume over configured limit blocked', baseOrder({ volume: settings.maxMt5OrderVolume + 0.01 }), 'order volume limit exceeded'));
  scenarios.push(await run('SDK notional over configured limit blocked', baseOrder({ provider: 'alpaca', notional: settings.maxSdkOrderNotional + 1 }), 'order notional limit exceeded'));
  scenarios.push(await run('Changed account binding blocked', baseOrder({ account: '999999@Other Server' }), 'account identity changed'));
  scenarios.push(await run('Alpaca live without exact acknowledgement blocked', baseOrder({ provider: 'alpaca', environment: 'live' }), 'explicit live acknowledgement required'));
  scenarios.push(await run('Alpaca live exact acknowledgement still stays offline', baseOrder({
    provider: 'alpaca',
    environment: 'live',
    liveAcknowledgement: LIVE_TRADING_ACKNOWLEDGEMENT,
  }), 'Alpaca manual market orders are handled in the Broker panel outside this protected-order simulation'));
  scenarios.push(await run('Alpaca paper orders use the separate manual route', baseOrder({ provider: 'alpaca', environment: 'paper' }), 'Alpaca manual market orders are handled in the Broker panel outside this protected-order simulation'));
  scenarios.push(await run('Read-only provider submission blocked', baseOrder({ provider: 'schwab' }), 'provider has no SDK order API'));
  scenarios.push(await run('MT5 broker rejection is journaled as rejected', baseOrder(), 'rejected', async () => ({ status: 'rejected' })));

  const duplicate = new MockOrderSession(policy);
  const duplicateOrder = baseOrder();
  await duplicate.submit(duplicateOrder, async () => ({ status: 'filled', protected: true }));
  const duplicateOutcome = await duplicate.submit(duplicateOrder, async () => ({ status: 'filled', protected: true }));
  scenarios.push({
    id: 'duplicate-intent',
    provider: 'mt5',
    scenario: 'Duplicate intent blocked',
    passed: duplicateOutcome === 'duplicate intent' && duplicate.mockCalls === 1,
    outcome: `${duplicateOutcome} · mock sends: ${duplicate.mockCalls}`,
  });

  const concurrent = new MockOrderSession(policy);
  let release!: () => void;
  const first = concurrent.submit(baseOrder(), () => new Promise(resolve => {
    release = () => resolve({ status: 'filled', protected: true });
  }));
  await Promise.resolve();
  const concurrentOutcome = await concurrent.submit(baseOrder({ id: 'scenario-2' }), async () => ({ status: 'filled', protected: true }));
  release();
  await first;
  scenarios.push({
    id: 'concurrent-submit',
    provider: 'mt5',
    scenario: 'Concurrent duplicate submit blocked',
    passed: concurrentOutcome === 'submission already in progress' && concurrent.mockCalls === 1,
    outcome: `${concurrentOutcome} · mock sends: ${concurrent.mockCalls}`,
  });

  const timeout = new MockOrderSession(policy);
  await timeout.submit(baseOrder(), async () => ({ status: 'timeout' }));
  const timeoutRetry = await timeout.submit(baseOrder({ id: 'scenario-2' }), async () => ({ status: 'filled', protected: true }));
  scenarios.push({
    id: 'timeout-reconciliation',
    provider: 'mt5',
    scenario: 'Unknown timeout requires reconciliation',
    passed: timeout.journal.get('scenario-1') === 'unknown' && timeoutRetry === 'unresolved journal entry blocks submission',
    outcome: `${timeoutRetry} · journal: ${timeout.journal.get('scenario-1')}`,
  });

  const partial = new MockOrderSession(policy);
  await partial.submit(baseOrder(), async () => ({ status: 'partial' }));
  const partialRetry = await partial.submit(baseOrder({ id: 'scenario-2' }), async () => ({ status: 'filled', protected: true }));
  scenarios.push({
    id: 'partial-fill-reconciliation',
    provider: 'mt5',
    scenario: 'Partial fill blocks further orders',
    passed: partial.journal.get('scenario-1') === 'partial' && partialRetry === 'unresolved journal entry blocks submission',
    outcome: `${partialRetry} · journal: ${partial.journal.get('scenario-1')}`,
  });

  const reconciled = new MockOrderSession(policy);
  await reconciled.submit(baseOrder(), async () => ({ status: 'timeout' }));
  reconciled.reconcile('scenario-1');
  const afterReconcile = await reconciled.submit(baseOrder({ id: 'scenario-2' }), async () => ({ status: 'filled', protected: true }));
  scenarios.push({
    id: 'journal-reconciliation',
    provider: 'mt5',
    scenario: 'Reconciled journal permits a new intent',
    passed: reconciled.journal.get('scenario-1') === 'reconciled' && afterReconcile === 'protected',
    outcome: `${afterReconcile} · mock sends: ${reconciled.mockCalls}`,
  });

  const unknownStatus = new MockOrderSession(policy);
  const unknownOutcome = await unknownStatus.submit(baseOrder(), async () => ({ status: 'unknown' }));
  const unknownRetry = await unknownStatus.submit(baseOrder({ id: 'scenario-2' }), async () => ({ status: 'filled', protected: true }));
  scenarios.push({
    id: 'unknown-broker-status',
    provider: 'mt5',
    scenario: 'Unknown broker status requires reconciliation',
    passed: unknownOutcome === 'unknown' && unknownRetry === 'unresolved journal entry blocks submission',
    outcome: `${unknownRetry} · journal: ${unknownStatus.journal.get('scenario-1')}`,
  });

  const unprotected = new MockOrderSession(policy);
  const unprotectedOutcome = await unprotected.submit(baseOrder(), async () => ({ status: 'filled', protected: false }));
  scenarios.push({
    id: 'unprotected-fill',
    provider: 'mt5',
    scenario: 'Fill without accepted protection is unresolved',
    passed: unprotectedOutcome === 'unknown' && unprotected.journal.get('scenario-1') === 'unknown',
    outcome: `${unprotectedOutcome} · stop-loss protection not confirmed`,
  });

  const corrupt = new MockOrderSession(policy);
  corrupt.integrityOk = false;
  const journalOutcome = await corrupt.submit(baseOrder(), async () => ({ status: 'filled', protected: true }));
  scenarios.push({
    id: 'journal-integrity',
    provider: 'mt5',
    scenario: 'Invalid journal integrity blocks order',
    passed: journalOutcome === 'journal integrity failed' && corrupt.mockCalls === 0,
    outcome: `${journalOutcome} · no send`,
  });

  return scenarios;
}
