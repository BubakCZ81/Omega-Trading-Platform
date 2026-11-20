import {
  registerIcon,
  registerNativeIndicator,
  registerRendererLayer,
  registerWidgetAction,
  type NativeIndicatorContext,
  type RendererLayerArgs,
  type WidgetContext,
} from './platform/index.ts';
import {
  findSupplyDemandZones,
  normalizeSupplyDemandSettings,
  type SupplyDemandSettings,
  type SupplyDemandZone,
} from './supplyDemandAlgorithm.ts';

const ZONE_TYPE = 'omega-supply-demand-zones';

interface SupplyDemandPayload {
  zones: SupplyDemandZone[];
  showLabels: boolean;
  extensionBars: number;
}

function isPayload(value: unknown): value is SupplyDemandPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<SupplyDemandPayload>;
  return Array.isArray(payload.zones)
    && typeof payload.showLabels === 'boolean'
    && typeof payload.extensionBars === 'number';
}

function clearCanvas(context: CanvasRenderingContext2D, args: RendererLayerArgs): void {
  context.setTransform(args.coords.dpr, 0, 0, args.coords.dpr, 0, 0);
  context.clearRect(0, 0, args.coords.width, args.coords.height);
}

registerRendererLayer({
  id: ZONE_TYPE,
  placement: 'above-data',
  create: () => {
    let context: CanvasRenderingContext2D | null = null;
    return {
      mount: canvas => {
        context = canvas.getContext('2d');
      },
      render: args => {
        if (!context) return;
        clearCanvas(context, args);
        if (!isPayload(args.data)) return;

        const { coords, bounds, scale } = args;
        context.save();
        context.beginPath();
        context.rect(0, bounds.top, coords.width, bounds.height);
        context.clip();

        for (const zone of args.data.zones) {
          const anchorX = coords.timeToX(zone.pivotTime);
          const topY = coords.priceToY(zone.top, scale, bounds);
          const bottomY = coords.priceToY(zone.bottom, scale, bounds);
          if (![anchorX, topY, bottomY].every(Number.isFinite)) continue;

          const zoneRight = Math.min(coords.width, anchorX + coords.bodySpacing() * args.data.extensionBars);
          const left = Math.max(0, anchorX);
          const top = Math.max(bounds.top, Math.min(topY, bottomY));
          const bottom = Math.min(bounds.top + bounds.height, Math.max(topY, bottomY));
          const width = zoneRight - left;
          const height = bottom - top;
          if (width <= 0 || height <= 0) continue;

          const isSupply = zone.side === 'supply';
          const color = isSupply ? '#ef5350' : '#26a69a';
          context.fillStyle = isSupply
            ? zone.invalidated ? 'rgba(239, 83, 80, 0.06)' : 'rgba(239, 83, 80, 0.13)'
            : zone.invalidated ? 'rgba(38, 166, 154, 0.06)' : 'rgba(38, 166, 154, 0.13)';
          context.strokeStyle = color;
          context.globalAlpha = zone.invalidated ? 0.45 : 0.8;
          context.lineWidth = 1;
          context.setLineDash(zone.invalidated ? [4, 3] : []);
          context.fillRect(left, top, width, height);
          context.strokeRect(left, top, width, height);

          if (args.data.showLabels && width >= 58 && height >= 14) {
            context.setLineDash([]);
            context.globalAlpha = zone.invalidated ? 0.55 : 1;
            context.fillStyle = color;
            context.font = '600 10px sans-serif';
            context.textBaseline = 'top';
            context.fillText(isSupply ? 'SUPPLY' : 'DEMAND', left + 5, top + 3);
          }
        }

        context.restore();
      },
    };
  },
});

registerNativeIndicator({
  type: ZONE_TYPE,
  title: 'Auto Supply & Demand Zones',
  shortTitle: 'Supply / Demand',
  paneHint: 'price',
  overlay: true,
  reactsToViewport: true,
  inputsSchema: () => [
    {
      key: 'swingStrength',
      title: 'Swing strength',
      type: 'int',
      defval: 4,
      min: 2,
      max: 30,
      group: 'Zone detection',
      tooltip: 'Confirmed swing bars required on both sides. A higher value produces fewer, broader zones.',
    },
    {
      key: 'atrPeriod',
      title: 'ATR period',
      type: 'int',
      defval: 14,
      min: 2,
      max: 200,
      group: 'Zone detection',
    },
    {
      key: 'departureAtr',
      title: 'Minimum departure (ATR)',
      type: 'float',
      defval: 0.8,
      min: 0.1,
      max: 5,
      step: 0.1,
      group: 'Zone detection',
      tooltip: 'Require price to move this ATR distance away from a confirmed swing before marking a zone.',
    },
    {
      key: 'confirmationWindow',
      title: 'Departure confirmation bars',
      type: 'int',
      defval: 12,
      min: 1,
      max: 100,
      group: 'Zone detection',
      tooltip: 'Maximum bars after a pivot confirmation in which the required price departure must occur.',
    },
    {
      key: 'zoneBasis',
      title: 'Zone boundaries',
      type: 'string',
      defval: 'wick',
      options: ['wick', 'body'],
      group: 'Zone display',
      tooltip: 'Use the pivot candle wick-to-body area or its full open-to-close body.',
    },
    {
      key: 'maxZones',
      title: 'Maximum zones per side',
      type: 'int',
      defval: 5,
      min: 1,
      max: 20,
      group: 'Zone display',
    },
    {
      key: 'extensionBars',
      title: 'Forward extension (bars)',
      type: 'int',
      defval: 250,
      min: 10,
      max: 5000,
      group: 'Zone display',
    },
    {
      key: 'removeInvalidated',
      title: 'Remove invalidated zones',
      type: 'bool',
      defval: true,
      group: 'Zone display',
      tooltip: 'A supply zone is invalidated by a close above its high; a demand zone by a close below its low.',
    },
    {
      key: 'showLabels',
      title: 'Show zone labels',
      type: 'bool',
      defval: true,
      group: 'Zone display',
    },
  ],
  defaultInputs: () => ({
    swingStrength: 4,
    atrPeriod: 14,
    departureAtr: 0.8,
    confirmationWindow: 12,
    zoneBasis: 'wick',
    maxZones: 5,
    extensionBars: 250,
    removeInvalidated: true,
    showLabels: true,
  }),
  create: () => {
    let context: NativeIndicatorContext | undefined;
    let settings = normalizeSupplyDemandSettings({});
    let extensionBars = 250;

    const publish = () => {
      if (!context) return;
      context.pushData({
        zones: findSupplyDemandZones(context.bars(), settings),
        showLabels: settings.showLabels,
        extensionBars,
      } satisfies SupplyDemandPayload);
    };

    const readInputs = (inputs: Record<string, string | number | boolean>) => {
      settings = normalizeSupplyDemandSettings(inputs);
      extensionBars = typeof inputs.extensionBars === 'number' && Number.isFinite(inputs.extensionBars)
        ? Math.max(10, Math.min(5000, Math.round(inputs.extensionBars)))
        : 250;
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
        context?.pushData({ zones: [], showLabels: false, extensionBars: 0 } satisfies SupplyDemandPayload);
        context = undefined;
      },
    };
  },
});

registerIcon(
  ZONE_TYPE,
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18v5H3z" fill="#ef5350" fill-opacity=".22" stroke="#ef5350"/><path d="M3 14h18v5H3z" fill="#26a69a" fill-opacity=".22" stroke="#26a69a"/><path d="M6 7.5h8M10 16.5h8"/></svg>',
);

function toggleSupplyDemand(ctx: WidgetContext): void {
  const existing = ctx.chart.indicators().find(indicator => indicator.nativeType === ZONE_TYPE);
  if (existing) existing.remove();
  else ctx.chart.addNativeIndicator(ZONE_TYPE);
}

registerWidgetAction({
  id: ZONE_TYPE,
  target: 'sidebar',
  label: 'Auto Supply & Demand Zones',
  icon: ZONE_TYPE,
  iconOnly: true,
  order: 14,
  mobile: 'menu',
  active: ctx => ctx.chart.indicators().some(indicator => indicator.nativeType === ZONE_TYPE),
  run: toggleSupplyDemand,
});
