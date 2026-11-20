'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { FootprintTickService } = require('./footprint-ticks.cjs');

let requestSequence = 0;
const pendingTickRequests = new Map();
const service = new FootprintTickService({
  directory: workerData.directory,
  fetchTicks: request => new Promise((resolve, reject) => {
    requestSequence += 1;
    const id = `ticks-${requestSequence}`;
    pendingTickRequests.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'fetch-ticks', id, request });
  }),
});

let profileQueue = Promise.resolve();

parentPort.on('message', message => {
  if (message?.type === 'fetch-ticks-result') {
    const pending = pendingTickRequests.get(message.id);
    if (!pending) return;
    pendingTickRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.ticks);
    return;
  }
  if (message?.type !== 'profiles-request' && message?.type !== 'live-profile-request') return;
  profileQueue = profileQueue.then(async () => {
    try {
      const profiles = message.type === 'profiles-request'
        ? await service.getProfiles(message.request)
        : await service.updateLiveProfile(message.request);
      parentPort.postMessage({ type: 'profiles-result', id: message.id, profiles });
    } catch (error) {
      parentPort.postMessage({
        type: 'profiles-result',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }).catch(error => {
    parentPort.postMessage({ type: 'profiles-result', id: message.id, error: String(error) });
  });
});
