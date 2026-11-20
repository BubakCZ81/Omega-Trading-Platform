import {
  registerIcon,
  registerNativeIndicator,
  registerWidgetAction,
  type DrawingLine,
  type NativeIndicatorContext,
  type WidgetContext,
} from './platform/index.ts';
import {
  findAutoTrendline,
  normalizeAutoTrendlineSettings,
  type AutoTrendlineSettings,
  type TrendlineSide,
} from './autoTrendlineAlgorithm.ts';

const UPPER_TYPE = 'omega-auto-upper-trendline';
const LOWER_TYPE = 'omega-auto-lower-trendline';
function lineFor(side: TrendlineSide, bars: Parameters<typeof findAutoTrendline>[0], settings: AutoTrendlineSettings): DrawingLine[] {
  const anchors = findAutoTrendline(bars, side, settings);
  if (!anchors) return [];
  return [{
    id: `${side}-trendline`,
    paneId: 'price',
    xloc: 'bar_index',
    x1: anchors.first.index,
    y1: anchors.first.price,
    x2: anchors.second.index,
    y2: anchors.second.price,
    extend: 'right',
    color: side === 'upper' ? '#ef5350' : '#26a69a',
    invisible: false,
    width: 2,
    style: 'solid',
    arrowLeft: false,
    arrowRight: false,
    overlay: true,
  }];
}

function registerTrendlineType(side: TrendlineSide, type: string, title: string): void {
  registerNativeIndicator({
    type,
    title,
    shortTitle: title,
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
        max: 5000,
        step: 10,
        tooltip: 'Maximum number of recent bars searched for confirmed swing pivots.',
      },
      {
        key: 'strength',
        title: 'Fractal strength',
        type: 'int',
        defval: 5,
        min: 2,
        max: 30,
        step: 1,
        tooltip: 'Bars required on each side of a pivot. Right-side bars confirm the pivot and prevent repainting.',
      },
      {
        key: 'minimumSeparation',
        title: 'Minimum pivot separation',
        type: 'int',
        defval: 8,
        min: 1,
        max: 500,
        step: 1,
        tooltip: 'Minimum bars between selected pivots.',
      },
    ],
    defaultInputs: () => ({
      lookback: 300,
      strength: 5,
      minimumSeparation: 8,
    }),
    create: () => {
      let context: NativeIndicatorContext | undefined;
      let settings = normalizeAutoTrendlineSettings({});
      const publish = () => {
        if (context) context.emit({ lines: lineFor(side, context.bars(), settings) });
      };
      return {
        start: (nextContext, inputs) => {
          context = nextContext;
          settings = normalizeAutoTrendlineSettings(inputs);
          publish();
        },
        onBars: publish,
        onViewport: publish,
        setInputs: inputs => {
          settings = normalizeAutoTrendlineSettings(inputs);
          publish();
        },
        suspend: () => undefined,
        resume: publish,
        stop: () => {
          publish();
          context = undefined;
        },
      };
    },
  });
}

registerTrendlineType('upper', UPPER_TYPE, 'Auto Upper Trendline');
registerTrendlineType('lower', LOWER_TYPE, 'Auto Lower Trendline');

registerIcon(
  'omega-auto-upper-trendline',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19 21 5" stroke="#ef5350"/><path d="M3 5 21 19" stroke="#26a69a" opacity=".7"/><circle cx="7" cy="16" r="1.2" fill="#ef5350"/><circle cx="17" cy="8" r="1.2" fill="#ef5350"/></svg>',
);
registerIcon(
  'omega-auto-lower-trendline',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19 21 5" stroke="#ef5350" opacity=".7"/><path d="M3 5 21 19" stroke="#26a69a"/><circle cx="7" cy="8" r="1.2" fill="#26a69a"/><circle cx="17" cy="16" r="1.2" fill="#26a69a"/></svg>',
);

function toggleTrendline(ctx: WidgetContext, type: string): void {
  const existing = ctx.chart.indicators().find(indicator => indicator.nativeType === type);
  if (existing) existing.remove();
  else ctx.chart.addNativeIndicator(type);
}

registerWidgetAction({
  id: UPPER_TYPE,
  target: 'sidebar',
  label: 'Auto Upper Trendline',
  icon: UPPER_TYPE,
  iconOnly: true,
  order: 12,
  mobile: 'menu',
  active: ctx => ctx.chart.indicators().some(indicator => indicator.nativeType === UPPER_TYPE),
  run: ctx => toggleTrendline(ctx, UPPER_TYPE),
});

registerWidgetAction({
  id: LOWER_TYPE,
  target: 'sidebar',
  label: 'Auto Lower Trendline',
  icon: LOWER_TYPE,
  iconOnly: true,
  order: 13,
  mobile: 'menu',
  active: ctx => ctx.chart.indicators().some(indicator => indicator.nativeType === LOWER_TYPE),
  run: ctx => toggleTrendline(ctx, LOWER_TYPE),
});
