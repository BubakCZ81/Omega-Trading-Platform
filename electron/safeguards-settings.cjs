'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getMt5LiveOrderLimits } = require('./live-orders.cjs');

const MAX_MT5_ORDER_VOLUME = 10000;
const DEFAULT_SDK_ORDER_NOTIONAL = 100;
const MAX_SDK_ORDER_NOTIONAL = 10_000;

function validateSafeguardSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid safeguards settings.');
  }
  const maxMt5OrderVolume = Number(value.maxMt5OrderVolume);
  if (!Number.isFinite(maxMt5OrderVolume) || maxMt5OrderVolume <= 0 || maxMt5OrderVolume > MAX_MT5_ORDER_VOLUME) {
    throw new Error(`Maximum MT5 order volume must be positive and no greater than ${MAX_MT5_ORDER_VOLUME} lots.`);
  }
  const maxSdkOrderNotional = Number(value.maxSdkOrderNotional);
  if (!Number.isFinite(maxSdkOrderNotional) || maxSdkOrderNotional < 1 || maxSdkOrderNotional > MAX_SDK_ORDER_NOTIONAL) {
    throw new Error(`SDK scenario notional cap must be between 1 and ${MAX_SDK_ORDER_NOTIONAL} USD.`);
  }
  return { version: 1, maxMt5OrderVolume, maxSdkOrderNotional };
}

class SafeguardsSettingsStore {
  constructor({ directory, fileName = 'safeguards.json' }) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('A safeguards settings directory is required.');
    this.directory = directory;
    this.file = path.join(directory, fileName);
  }

  read() {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const volume = getMt5LiveOrderLimits();
        return {
          settings: validateSafeguardSettings({
            maxMt5OrderVolume: volume.maxVolume,
            maxSdkOrderNotional: DEFAULT_SDK_ORDER_NOTIONAL,
          }),
          source: volume.source,
        };
      }
      if (error instanceof SyntaxError) throw new Error('Safeguards settings are corrupt; live orders are blocked until repaired.');
      throw error;
    }
    if (value.version !== 1) throw new Error('Safeguards settings have an unsupported version; live orders are blocked.');
    const storedVolume = Number(value.maxMt5OrderVolume);
    if (Number.isFinite(storedVolume) && storedVolume > MAX_MT5_ORDER_VOLUME) {
      const settings = validateSafeguardSettings({
        ...value,
        maxMt5OrderVolume: MAX_MT5_ORDER_VOLUME,
      });
      this.write(settings);
      return { settings, source: 'stored' };
    }
    return { settings: validateSafeguardSettings(value), source: 'stored' };
  }

  write(value) {
    const settings = validateSafeguardSettings(value);
    fs.mkdirSync(this.directory, { recursive: true });
    const temporaryFile = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporaryFile, this.file);
      return settings;
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(temporaryFile);
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }
}

module.exports = {
  DEFAULT_SDK_ORDER_NOTIONAL,
  MAX_MT5_ORDER_VOLUME,
  MAX_SDK_ORDER_NOTIONAL,
  SafeguardsSettingsStore,
  validateSafeguardSettings,
};
