const patches = [
  {
    from: 'closeOnInteractOutside: opts.closeOnInteractOutside ?? true,',
    to: 'closeOnInteractOutside: opts.closeOnInteractOutside ?? false,',
    expected: 1,
    label: 'default drawer outside-dismissal policy',
  },
  {
    from: 'closeOnInteractOutside: true,',
    to: 'closeOnInteractOutside: false,',
    expected: 4,
    label: 'dialog outside-dismissal policy',
  },
  {
    from: 'const onOutside = (ev) => {\n      const t = ev.target;\n      if (this.el.contains(t) || this.trigger.contains(t)) return;\n      markPopoverDismiss(ev);\n      this.hide();\n    };',
    to: 'const onOutside = () => {};',
    expected: 1,
    label: 'popover outside-dismissal handler',
  },
  {
    from: 'this.onOutside = (e) => {\n      const target = e.target;\n      if (this.flyout && !this.flyout.contains(target) && !this.root.contains(target)) this.closeFlyout();\n    };',
    to: 'this.onOutside = () => {};',
    expected: 1,
    label: 'drawing toolbar outside-dismissal handler',
  },
  {
    from: 'this.close();\n      this.host.onBackdropClose();',
    to: 'return;',
    expected: 1,
    label: 'settings dialog backdrop dismissal',
  },
  {
    from: 'closeOnBackdrop: true,',
    to: 'closeOnBackdrop: false,',
    expected: 1,
    label: 'settings dialog backdrop policy',
  },
  {
    from: 'this.onOutside = (e) => {\n      const node = e.target;\n      if (this.panel.isOpen()) {\n        if (this.panel.contains(node) || this.isOwnChrome(node)) return;\n        if (this.host.contains(node)) return;\n        this.panel.close();\n        return;\n      }\n      if (this.isOwnChrome(node)) return;\n      const cb = this.onClose;\n      this.close();\n      cb?.(e);\n    };',
    to: 'this.onOutside = () => {};',
    expected: 1,
    label: 'drawing settings outside-dismissal handler',
  },
  {
    from: 'const key = `${(s.prefix ?? s.provider ?? "").toLowerCase()}:${s.ticker.toUpperCase()}`;',
    to: 'const key = `${(s.provider ?? "").toLowerCase()}:${(s.prefix ?? "").toLowerCase()}:${s.ticker.toUpperCase()}`;',
    expected: 1,
    label: 'provider-aware symbol result identity',
  },
  {
    from: 'this.select(target.ticker, target.prefix ?? target.provider, this.opts.onSelect);',
    to: 'this.select(target.ticker, target.provider ?? target.prefix, this.opts.onSelect);',
    expected: 1,
    label: 'selecting the symbol from its owning provider',
  },
  {
    from: 'badge.textContent = venue;',
    to: 'badge.textContent = (s.provider ?? venue).toUpperCase();',
    expected: 1,
    label: 'visible symbol provider badge',
  },
  {
    from: 'setBars(times) {\n    this.times = times.slice();\n    this.intervalMs = medianInterval(this.times);\n  }',
    to: 'setBars(times, intervalMs) {\n    this.times = times.slice();\n    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : medianInterval(this.times);\n  }',
    expected: 1,
    label: 'coordinate-system timeframe interval',
  },
  {
    from: 'this.bars = normalizeBars(bars);\n    this.scene.bars = this.bars;\n    this.coords.setBars(this.bars.map((b) => b.time));',
    to: 'this.bars = normalizeBars(bars);\n    this.scene.bars = this.bars;\n    this.coords.setBars(this.bars.map((b) => b.time), opts?.intervalMs);',
    expected: 1,
    label: 'renderer interval forwarding',
  },
  {
    from: 'this.renderer.setBars(this.bars, { preserveView: true });',
    to: 'this.renderer.setBars(this.bars, { preserveView: true, intervalMs: /^(?:T\\d+|R(?:G?\\d+|ANGE\\d+|ATR))$/i.test(this.config.market.timeframe ?? "") ? undefined : timeframeToMs(this.config.market.timeframe ?? "60") });',
    expected: 1,
    label: 'transformed-bar timeframe interval',
  },
  {
    from: 'this.renderer.setBars(this.bars, { preserveView: opts?.preserveView });',
    to: 'this.renderer.setBars(this.bars, { preserveView: opts?.preserveView, intervalMs: /^(?:T\\d+|R(?:G?\\d+|ANGE\\d+|ATR))$/i.test(this.config.market.timeframe ?? "") ? undefined : timeframeToMs(this.config.market.timeframe ?? "60") });',
    expected: 1,
    label: 'loaded-bar timeframe interval',
  },
  {
    from: '  setVisibleRangePreset(preset) {\n    this.orchestrator.setVisibleRangePreset(preset);',
    to: `  setVisibleBarCount(count) {
    const bars = this.orchestrator.bars;
    const visible = Math.min(count, bars.length);
    if (visible > 0) this.rendererPort.setVisibleRange({ from: bars[bars.length - visible].time, to: bars[bars.length - 1].time }, { rightMargin: true });
    return visible;
  }
  setVisibleRangePreset(preset) {
    this.orchestrator.setVisibleRangePreset(preset);`,
    expected: 1,
    label: 'viewport reset by candle count',
  },
  {
    from: 'const identityChanged = next.symbol !== void 0 && next.symbol !== m.symbol',
    to: 'const identityChanged = next.reload === true || next.symbol !== void 0 && next.symbol !== m.symbol',
    expected: 1,
    label: 'explicit market and indicator reload',
  },
  {
    from: 'if (identityChanged) {\n        this.beginLoad(false);',
    to: 'if (identityChanged) {\n        if (next.reload === true) this.feed.invalidateMarket?.(m);\n        this.beginLoad(false);',
    expected: 1,
    label: 'chart refresh history invalidation',
  },
  {
    from: '  async load(cfg) {\n    if (cfg.data && cfg.data.length > 0) return cfg.data;',
    to: `  invalidateMarket(cfg) {
    if (cfg.data?.length) return;
    const resolved = this.registry.resolve(rawSymbol(cfg), { default: this.primaryProvider });
    if (!resolved) return;
    const key = cacheKey(canonical(cfg, resolved).symbol, cfg.timeframe ?? "60", cfg.session);
    this.cache.store.series.delete(key);
    this.cache.store.coveredFrom.delete(key);
  }
  async load(cfg) {
    if (cfg.data && cfg.data.length > 0) return cfg.data;`,
    expected: 1,
    label: 'scoped bar cache invalidation',
  },
];

export function patchVelaDismissal(chunkName, source) {
  if (!/^chunk-[\w-]+\.js$/.test(chunkName)) return null;

  let patchedSource = source;
  let changed = false;
  for (const { from, to, expected, label } of patches) {
    const occurrences = patchedSource.split(from).length - 1;
    if (occurrences === 0) continue;
    if (occurrences !== expected) {
      throw new Error(
        `Unexpected @luxalgo/vela ${chunkName} source: expected ${expected} occurrence(s) of ${label}, found ${occurrences}.`,
      );
    }
    patchedSource = patchedSource.replaceAll(from, to);
    changed = true;
  }

  return changed ? patchedSource : null;
}

export function velaManualDismissalPlugin() {
  return {
    name: 'vela-manual-dismissal',
    enforce: 'pre',
    transform(source, id) {
      const normalizedId = id.replaceAll('\\', '/');
      if (!normalizedId.includes('/node_modules/@luxalgo/vela/dist/')) return null;

      const chunkName = normalizedId.slice(normalizedId.lastIndexOf('/') + 1);
      const patchedSource = patchVelaDismissal(chunkName, source);
      return patchedSource === null ? null : { code: patchedSource, map: null };
    },
  };
}
