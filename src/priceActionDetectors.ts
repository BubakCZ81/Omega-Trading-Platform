import {
  registerIcon,
  registerNativeIndicator,
  registerWidgetAction,
  type InputValue,
  type NativeIndicatorContext,
  type WidgetContext,
} from './platform/index.ts';
import {
  findCandlePatternLabels,
  findMarketStructure,
  normalizeCandlePatternSettings,
  normalizeMarketStructureSettings,
} from './priceActionAlgorithm.ts';

const CANDLE_TYPE = 'omega-candle-pattern-detector';
const STRUCTURE_TYPE = 'omega-market-structure';

registerNativeIndicator({
  type: CANDLE_TYPE,
  title: 'Candle Pattern Detector',
  shortTitle: 'Candle Patterns',
  paneHint: 'price',
  overlay: true,
  reactsToViewport: true,
  inputsSchema: () => [
    {
      key: 'lookback',
      title: 'Lookback bars',
      type: 'int',
      defval: 300,
      min: 10,
      max: 2000,
      group: 'Detection',
    },
    {
      key: 'wickBodyRatio',
      title: 'Min wick / body ratio',
      type: 'float',
      defval: 2,
      min: 1,
      max: 10,
      step: 0.1,
      group: 'Detection',
      tooltip: 'Minimum long-wick to candle-body ratio for hammer and shooting-star patterns.',
    },
    {
      key: 'maxBodyRangeRatio',
      title: 'Max body / range ratio',
      type: 'float',
      defval: 0.3,
      min: 0.05,
      max: 0.8,
      step: 0.05,
      group: 'Detection',
      tooltip: 'Maximum body-to-range ratio for wick patterns and doji detection.',
    },
    {
      key: 'volumeFilter',
      title: 'Require relative volume',
      type: 'bool',
      defval: false,
      group: 'Volume confirmation',
      tooltip: 'When enabled, patterns are shown only when the closed candle exceeds the configured average-volume threshold.',
    },
    {
      key: 'volumeLookback',
      title: 'Volume average bars',
      type: 'int',
      defval: 20,
      min: 2,
      max: 200,
      group: 'Volume confirmation',
      when: [{ key: 'volumeFilter', equals: true }],
    },
    {
      key: 'volumeMultiple',
      title: 'Relative volume multiple',
      type: 'float',
      defval: 1.2,
      min: 0.1,
      max: 5,
      step: 0.1,
      group: 'Volume confirmation',
      when: [{ key: 'volumeFilter', equals: true }],
    },
  ],
  defaultInputs: () => ({
    lookback: 300,
    wickBodyRatio: 2,
    maxBodyRangeRatio: 0.3,
    volumeFilter: false,
    volumeLookback: 20,
    volumeMultiple: 1.2,
  }),
  create: () => {
    let context: NativeIndicatorContext | undefined;
    let settings = normalizeCandlePatternSettings({});
    const publish = () => {
      if (!context) return;
      context.emit({
        labels: findCandlePatternLabels(context.bars(), settings, {
          live: context.live,
          maximumLabels: 100,
        }),
      });
    };
    const readInputs = (inputs: Record<string, InputValue>) => {
      settings = normalizeCandlePatternSettings(inputs);
    };
    return {
      start: (nextContext, inputs) => {
        context = nextContext;
        readInputs(inputs);
        publish();
      },
      onBars: publish,
      onViewport: publish,
      setInputs: inputs => {
        readInputs(inputs);
        publish();
      },
      suspend: () => undefined,
      resume: publish,
      stop: () => {
        context?.emit({ labels: [] });
        context = undefined;
      },
    };
  },
});

registerNativeIndicator({
  type: STRUCTURE_TYPE,
  title: 'Market Structure Detector',
  shortTitle: 'Market Structure',
  paneHint: 'price',
  overlay: true,
  reactsToViewport: true,
  inputsSchema: () => [
    {
      key: 'lookback',
      title: 'Lookback bars',
      type: 'int',
      defval: 300,
      min: 30,
      max: 2000,
      group: 'Structure',
    },
    {
      key: 'strength',
      title: 'Swing strength',
      type: 'int',
      defval: 3,
      min: 2,
      max: 30,
      group: 'Structure',
      tooltip: 'A swing is confirmed only after this many bars form on both sides; no unconfirmed pivot labels are shown.',
    },
    {
      key: 'minimumSeparation',
      title: 'Minimum swing separation',
      type: 'int',
      defval: 3,
      min: 1,
      max: 500,
      group: 'Structure',
    },
    {
      key: 'showSwings',
      title: 'Show HH / HL / LH / LL',
      type: 'bool',
      defval: true,
      group: 'Display',
    },
    {
      key: 'showBreaks',
      title: 'Show BOS / CHoCH',
      type: 'bool',
      defval: true,
      group: 'Display',
    },
  ],
  defaultInputs: () => ({
    lookback: 300,
    strength: 3,
    minimumSeparation: 3,
    showSwings: true,
    showBreaks: true,
  }),
  create: () => {
    let context: NativeIndicatorContext | undefined;
    let settings = normalizeMarketStructureSettings({});
    let showSwings = true;
    let showBreaks = true;
    const publish = () => {
      if (!context) return;
      context.emit(findMarketStructure(context.bars(), settings, {
        live: context.live,
        showSwings,
        showBreaks,
      }));
    };
    const readInputs = (inputs: Record<string, InputValue>) => {
      settings = normalizeMarketStructureSettings(inputs);
      showSwings = typeof inputs.showSwings === 'boolean' ? inputs.showSwings : true;
      showBreaks = typeof inputs.showBreaks === 'boolean' ? inputs.showBreaks : true;
    };
    return {
      start: (nextContext, inputs) => {
        context = nextContext;
        readInputs(inputs);
        publish();
      },
      onBars: publish,
      onViewport: publish,
      setInputs: inputs => {
        readInputs(inputs);
        publish();
      },
      suspend: () => undefined,
      resume: publish,
      stop: () => {
        context?.emit({ labels: [], lines: [] });
        context = undefined;
      },
    };
  },
});

registerIcon(
  CANDLE_TYPE,
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 3v5m0 8v5M4 8h4v8H4zM17 2v3m0 13v4m-2-14h4v8h-4z"/></svg>',
);
registerIcon(
  STRUCTURE_TYPE,
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19h5v-5h5V9h8"/><path d="m17 5 4 4-4 4"/></svg>',
);

function toggleIndicator(ctx: WidgetContext, type: string): void {
  const existing = ctx.chart.indicators().find(indicator => indicator.nativeType === type);
  if (existing) existing.remove();
  else ctx.chart.addNativeIndicator(type);
}

registerWidgetAction({
  id: CANDLE_TYPE,
  target: 'sidebar',
  label: 'Candle Pattern Detector',
  icon: CANDLE_TYPE,
  iconOnly: true,
  order: 15,
  mobile: 'menu',
  active: ctx => ctx.chart.indicators().some(indicator => indicator.nativeType === CANDLE_TYPE),
  run: ctx => toggleIndicator(ctx, CANDLE_TYPE),
});

registerWidgetAction({
  id: STRUCTURE_TYPE,
  target: 'sidebar',
  label: 'Market Structure Detector',
  icon: STRUCTURE_TYPE,
  iconOnly: true,
  order: 16,
  mobile: 'menu',
  active: ctx => ctx.chart.indicators().some(indicator => indicator.nativeType === STRUCTURE_TYPE),
  run: ctx => toggleIndicator(ctx, STRUCTURE_TYPE),
});
