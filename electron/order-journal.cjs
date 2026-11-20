'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const DEFAULT_FILE_NAME = 'orders.jsonl';
const MAX_RECORD_BYTES = 16 * 1024;

/**
 * Statuses that still need a human or an automatic reconciliation before the
 * order can be considered settled. `unknown` means the request may have
 * reached the broker; treat the broker, not this file, as the source of truth.
 */
const OPEN_STATUSES = new Set(['intent', 'sent', 'unknown', 'filled', 'partial', 'unprotected']);

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashRecord(record) {
  return createHash('sha256').update(canonicalize(record)).digest('hex');
}

function sanitizeData(data) {
  if (data === undefined) return null;
  let text;
  try {
    text = JSON.stringify(data);
  } catch (error) {
    throw new Error(`Order journal data is not serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text === undefined) return null;
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new Error('Order journal record is too large.');
  return JSON.parse(text);
}

function readJournal(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { records: [], lastSeq: 0, lastHash: '', integrity: true, tailTruncated: false, validBytes: 0 };
    }
    throw error;
  }

  const lines = text.split('\n');
  const records = [];
  let lastSeq = 0;
  let lastHash = '';
  let integrity = true;
  let tailTruncated = false;
  let validBytes = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      // A power loss can leave the final write incomplete. Any other
      // unreadable line means the file was edited or corrupted.
      const isTail = lines.slice(index + 1).every((remaining) => !remaining.trim());
      if (isTail) tailTruncated = true;
      else integrity = false;
      break;
    }

    const { hash, ...body } = record;
    const bodyIsValid = body
      && Number.isInteger(body.seq)
      && typeof body.at === 'string'
      && typeof body.type === 'string'
      && typeof body.status === 'string'
      && typeof body.id === 'string'
      && typeof body.prevHash === 'string';

    if (!bodyIsValid
      || typeof hash !== 'string'
      || hashRecord(body) !== hash
      || body.prevHash !== lastHash
      || body.seq !== lastSeq + 1) {
      integrity = false;
      break;
    }

    records.push(record);
    lastSeq = body.seq;
    lastHash = hash;
    validBytes += Buffer.byteLength(line, 'utf8') + 1;
  }

  return { records, lastSeq, lastHash, integrity, tailTruncated, validBytes };
}

/**
 * Append-only, fsync'd order journal with a hash chain.
 *
 * The journal records intent and state transitions. It is deliberately small:
 * no secrets, no credentials, no full broker payloads. The broker remains the
 * source of truth for what actually exists; this file exists so an order is
 * never silently lost when the app crashes between sending and reconciling.
 */
class OrderJournal {
  constructor({ directory, fileName = DEFAULT_FILE_NAME, clock = () => Date.now() } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('An order journal directory is required.');
    this.directory = directory;
    this.file = path.join(directory, fileName);
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    fs.mkdirSync(directory, { recursive: true });

    const state = readJournal(this.file);
    this.records = state.records;
    this.seq = state.lastSeq;
    this.lastHash = state.lastHash;
    this.integrity = state.integrity;
    this.repairedTail = false;
    // A crash can leave one incomplete trailing write. Drop only that fragment
    // so the next append starts on a clean line; never rewrite valid records.
    if (state.tailTruncated && state.integrity) {
      fs.truncateSync(this.file, state.validBytes);
      this.repairedTail = true;
    }
    this.tailTruncated = false;
    this.ids = new Set(state.records.filter((record) => record.type === 'intent').map((record) => record.id));
    this.closed = false;
    this.fd = fs.openSync(this.file, 'a');
  }

  nowIso() {
    const value = this.clock();
    return new Date(value instanceof Date ? value.getTime() : value).toISOString();
  }

  append(type, id, status, data) {
    if (this.closed) throw new Error('The order journal is closed.');
    const body = {
      seq: this.seq + 1,
      at: this.nowIso(),
      type,
      id,
      status,
      data: sanitizeData(data),
      prevHash: this.lastHash,
    };
    const hash = hashRecord(body);
    const line = `${JSON.stringify({ ...body, hash })}\n`;

    // A failed write or flush leaves the on-disk tail uncertain. Poison this
    // instance so callers cannot retry with the same sequence and send anyway.
    try {
      const bytesWritten = fs.writeSync(this.fd, line, null, 'utf8');
      if (bytesWritten !== Buffer.byteLength(line, 'utf8')) {
        throw new Error('The order journal write was incomplete.');
      }
      fs.fsyncSync(this.fd);
    } catch (error) {
      this.integrity = false;
      throw error;
    }

    this.seq = body.seq;
    this.lastHash = hash;
    const record = { ...body, hash };
    this.records.push(record);
    return record;
  }

  /**
   * Record the intent before any network request. Throws when the journal is
   * unusable so a caller can refuse to send an unaudited order.
   */
  begin(intent) {
    if (!this.integrity) throw new Error('The order journal failed its integrity check; refusing to record or send an order.');
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new Error('An order intent is required.');
    const id = typeof intent.id === 'string' && intent.id.trim() ? intent.id.trim() : randomUUID();
    if (this.ids.has(id)) throw new Error(`Order intent ${id} already exists in the journal.`);
    const record = this.append('intent', id, 'intent', intent);
    this.ids.add(id);
    return { id, at: record.at, status: 'intent' };
  }

  transition(id, status, data) {
    if (!this.integrity) throw new Error('The order journal failed its integrity check.');
    if (typeof id !== 'string' || !id.trim()) throw new Error('An order intent id is required.');
    if (typeof status !== 'string' || !status.trim()) throw new Error('An order status is required.');
    if (!this.ids.has(id)) throw new Error(`Order intent ${id} is not in the journal.`);
    const record = this.append('status', id, status, data);
    return record;
  }

  /** Newest-first summary of every intent and its latest status. */
  recent(limit = 50) {
    const byId = new Map();
    for (const record of this.records) {
      if (record.type === 'intent') {
        byId.set(record.id, {
          id: record.id,
          at: record.at,
          updatedAt: record.at,
          status: 'intent',
          data: record.data,
        });
      } else {
        const entry = byId.get(record.id);
        if (!entry) continue;
        entry.status = record.status;
        entry.updatedAt = record.at;
        entry.details = record.data;
      }
    }
    return [...byId.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(0, Number(limit) || 0));
  }

  /** Entries that still need reconciliation or attention. */
  openEntries() {
    return this.recent(this.records.length).filter((entry) => OPEN_STATUSES.has(entry.status));
  }

  get(id) {
    return this.recent(this.records.length).find((entry) => entry.id === id) ?? null;
  }

  /**
   * Close an unresolved entry after the operator has checked the broker.
   * This is an explicit acknowledgement, not an automatic reconciliation.
   */
  resolve(id, data = {}) {
    const entry = this.get(id);
    if (!entry) throw new Error(`Order intent ${id} is not in the journal.`);
    if (!OPEN_STATUSES.has(entry.status)) throw new Error(`Order ${id} is already ${entry.status}.`);
    const record = this.transition(id, 'reconciled', data);
    return { id, at: record.at, status: 'reconciled' };
  }

  verify() {
    return {
      ok: this.integrity && !this.tailTruncated,
      integrity: this.integrity,
      tailTruncated: this.tailTruncated,
      repairedTail: this.repairedTail,
      records: this.records.length,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }
}

module.exports = { OrderJournal, OPEN_STATUSES, readJournal };
