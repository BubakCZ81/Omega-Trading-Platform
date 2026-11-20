'use strict';

const ORDER_API_PROVIDERS = Object.freeze({
  alpaca: {
    environments: ['paper', 'live'],
    detail: 'SDK order API supports paper and live; live requires its exact acknowledgement.',
  },
});

function buildBrokerTradingCapabilities(brokers) {
  if (!Array.isArray(brokers)) throw new Error('Broker SDK provider list is unavailable.');
  return brokers.filter(broker => broker.id.toLowerCase() === 'alpaca').map(broker => {
    const orderApi = ORDER_API_PROVIDERS[broker.id];
    return {
      id: broker.id,
      displayName: broker.displayName,
      supportsBars: broker.supportsBars === true,
      sdkOrderApiAvailable: Boolean(orderApi),
      supportedOrderEnvironments: orderApi?.environments ?? [],
      detail: orderApi?.detail ?? 'No order API in the installed Broker SDK orders module.',
      appTradingStatus: 'manual-market-orders',
      appConnectionStatus: 'read-only',
    };
  });
}

module.exports = { buildBrokerTradingCapabilities };
