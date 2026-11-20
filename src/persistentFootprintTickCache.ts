export interface CachedFootprintTick {
  time: number;
  bid: number;
  ask: number;
  last: number;
  volume?: number;
  volumeReal?: number;
  flags?: number;
}

export interface FootprintTickRange {
  ticks: CachedFootprintTick[];
  covered: boolean;
  pipSize?: number;
}

interface StoredTick extends CachedFootprintTick {
  id: string;
  symbol: string;
}

interface StoredCoverage {
  symbol: string;
  pipSize: number;
  ranges: Array<[number, number]>;
}

const DATABASE_NAME = 'omega-footprint-ticks';
const DATABASE_VERSION = 1;
const TICK_STORE = 'ticks';
const COVERAGE_STORE = 'coverage';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Footprint tick cache request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Footprint tick cache transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Footprint tick cache transaction aborted.'));
  });
}

function mergeRanges(ranges: Array<[number, number]>, next: [number, number]): Array<[number, number]> {
  const sorted = [...ranges, next].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range[0] > previous[1] + 1) merged.push([...range]);
    else previous[1] = Math.max(previous[1], range[1]);
  }
  return merged;
}

export class PersistentFootprintTickCache {
  private database: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable.'));
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(TICK_STORE)) {
          const ticks = database.createObjectStore(TICK_STORE, { keyPath: 'id' });
          ticks.createIndex('symbolTime', ['symbol', 'time'], { unique: false });
        }
        if (!database.objectStoreNames.contains(COVERAGE_STORE)) {
          database.createObjectStore(COVERAGE_STORE, { keyPath: 'symbol' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the footprint tick cache.'));
      request.onblocked = () => reject(new Error('Opening the footprint tick cache was blocked.'));
    }).catch(error => {
      this.database = null;
      throw error;
    });
    this.database = opening;
    return opening;
  }

  async readRange(symbol: string, from: number, to: number): Promise<FootprintTickRange> {
    const database = await this.open();
    const transaction = database.transaction([TICK_STORE, COVERAGE_STORE], 'readonly');
    const normalized = symbol.replace(/^(?:CTRADER|MT5):/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    const tickRequest = transaction.objectStore(TICK_STORE).index('symbolTime').getAll(
      IDBKeyRange.bound([normalized, from], [normalized, to]),
    ) as IDBRequest<StoredTick[]>;
    const coverageRequest = transaction.objectStore(COVERAGE_STORE).get(normalized) as IDBRequest<StoredCoverage | undefined>;
    const [ticks, coverage] = await Promise.all([requestResult(tickRequest), requestResult(coverageRequest)]);
    return {
      ticks: ticks.map(({ id: _id, symbol: _symbol, ...tick }) => tick),
      covered: Boolean(coverage?.ranges.some(([start, end]) => start <= from && end >= to)),
      pipSize: coverage?.pipSize,
    };
  }

  async saveRange(
    symbol: string,
    pipSize: number,
    from: number,
    to: number,
    ticks: readonly CachedFootprintTick[],
    complete: boolean,
  ): Promise<void> {
    const database = await this.open();
    const normalized = symbol.replace(/^(?:CTRADER|MT5):/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    const transaction = database.transaction([TICK_STORE, COVERAGE_STORE], 'readwrite');
    const tickStore = transaction.objectStore(TICK_STORE);
    for (const tick of ticks) {
      const id = `${normalized}:${tick.time}:${tick.bid}:${tick.ask}:${tick.last}:${tick.flags ?? 0}`;
      tickStore.put({ ...tick, id, symbol: normalized } satisfies StoredTick);
    }
    if (complete) {
      const coverageStore = transaction.objectStore(COVERAGE_STORE);
      const request = coverageStore.get(normalized) as IDBRequest<StoredCoverage | undefined>;
      request.onsuccess = () => {
        const existing = request.result;
        coverageStore.put({
          symbol: normalized,
          pipSize,
          ranges: mergeRanges(existing?.ranges ?? [], [from, to]),
        } satisfies StoredCoverage);
      };
    }
    await transactionDone(transaction);
  }
}
