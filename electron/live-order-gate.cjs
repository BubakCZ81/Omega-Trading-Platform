'use strict';

function mt5AccountIdentity(status) {
  if (!status || status.connected !== true || status.tradingAllowed !== true) {
    if (status?.connected === true && status.terminalTradingAllowed === false) {
      throw new Error('Enable Algo Trading in the connected MT5 terminal before submitting an order.');
    }
    if (status?.connected === true && status.accountTradingAllowed === false) {
      throw new Error('The connected MT5 account does not permit trading.');
    }
    throw new Error('MT5 must be connected and permit trading before live orders are allowed.');
  }
  const login = String(status.accountLogin ?? '').trim();
  const server = String(status.server ?? '').trim();
  if (!login || !server) throw new Error('MT5 did not provide a complete account identity; live trading is blocked.');
  return { login, server };
}

function sameMt5Account(left, right) {
  return Boolean(left && right && left.login === right.login && left.server === right.server);
}

class Mt5LiveOrderGate {
  constructor({ getStatus, submitOrder }) {
    this.getStatus = getStatus;
    this.submitOrder = submitOrder;
    this.armedAccount = null;
    this.submissionInFlight = false;
    this.connectionRevision = 0;
  }

  disarm() {
    this.connectionRevision++;
    this.armedAccount = null;
  }

  binding() {
    return this.armedAccount ? { ...this.armedAccount } : null;
  }

  async status() {
    let status;
    try {
      status = await this.getStatus();
    } catch (error) {
      throw error;
    }
    return { ...status, armed: Boolean(this.armedAccount) };
  }

  async arm(shouldArm) {
    if (!shouldArm) {
      this.disarm();
      return { armed: false };
    }
    const revision = this.connectionRevision;
    const status = await this.getStatus();
    if (revision !== this.connectionRevision) throw new Error('MT5 session changed while enabling trading.');
    const identity = mt5AccountIdentity(status);
    this.armedAccount = identity;
    return {
      armed: true,
      accountLogin: identity.login,
      server: identity.server,
      accountMode: status.accountMode,
    };
  }

  submit(request) {
    if (this.submissionInFlight) {
      return Promise.reject(new Error('Another MT5 live order submission is already in progress. Wait for its result before submitting again.'));
    }
    this.submissionInFlight = true;
    return (async () => {
      try {
        const confirmedAccountId = request?.confirmedAccountId;
        if (!this.armedAccount && typeof confirmedAccountId !== 'string') {
          throw new Error('Live trading is not armed. Connect to MT5 first.');
        }
        const revision = this.connectionRevision;
        const actualAccount = mt5AccountIdentity(await this.getStatus());
        if (revision !== this.connectionRevision) throw new Error('MT5 session changed before submission. No order was sent.');
        const actualAccountId = `mt5:${actualAccount.login}@${actualAccount.server}`;
        if (confirmedAccountId !== undefined
          && (typeof confirmedAccountId !== 'string' || confirmedAccountId.toLowerCase() !== actualAccountId.toLowerCase())) {
          throw new Error('The signed-in MT5 account does not match the confirmed order account. No order was sent.');
        }
        if (this.armedAccount && !sameMt5Account(this.armedAccount, actualAccount)) {
          throw new Error('The signed-in MT5 account or server changed. Reconnect to MT5.');
        }
        this.armedAccount ??= actualAccount;
        return await this.submitOrder(request, actualAccount);
      } finally {
        this.submissionInFlight = false;
      }
    })();
  }
}

module.exports = { Mt5LiveOrderGate, mt5AccountIdentity, sameMt5Account };
