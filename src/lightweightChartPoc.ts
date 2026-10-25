import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  type IPriceLine,
  type PriceLineOptions,
  type Time,
} from 'lightweight-charts';
import { BinanceProvider } from '@luxalgo/vela/providers/binance';
import { createProtectionLevels, moveProtectionLevel, type PaperTradeSide } from './paperTradeMath';

const chartElement = document.getElementById('chart') as HTMLDivElement;
const statusElement = document.getElementById('status') as HTMLParagraphElement;
const buyButton = document.getElementById('buy') as HTMLButtonElement;
const sellButton = document.getElementById('sell') as HTMLButtonElement;
const clearButton = document.getElementById('clear') as HTMLButtonElement;

const chart = createChart(chartElement, {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: '#151619' },
    textColor: '#b2b5be',
    attributionLogo: true,
  },
  grid: {
    vertLines: { color: '#20222c' },
    horzLines: { color: '#20222c' },
  },
  rightPriceScale: { borderColor: '#2a2b30' },
  timeScale: { borderColor: '#2a2b30', timeVisible: true },
  crosshair: { mode: 0 },
});

const candles = chart.addSeries(CandlestickSeries, {
  upColor: '#089981',
  downColor: '#f23645',
  borderVisible: false,
  wickUpColor: '#089981',
  wickDownColor: '#f23645',
});

const provider = new BinanceProvider();
const minTick = 0.01;
const tradeColors = {
  entry: '#2962ff',
  stopLoss: '#ff9800',
  takeProfit: '#089981',
} as const;

type Trade = {
  side: PaperTradeSide;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  lines: Record<'entry' | 'stopLoss' | 'takeProfit', IPriceLine>;
};

let trade: Trade | null = null;
let dragging: 'stopLoss' | 'takeProfit' | null = null;
let unsubscribe: (() => void) | null = null;

function setStatus(message: string, error = false): void {
  statusElement.textContent = message;
  statusElement.dataset.state = error ? 'error' : 'ready';
}

function lineOptions(
  role: keyof typeof tradeColors,
  price: number,
  side: PaperTradeSide,
): PriceLineOptions {
  const name = role === 'entry' ? (side === 'buy' ? 'BUY' : 'SELL')
    : role === 'stopLoss' ? 'SL' : 'TP';
  return {
    price,
    color: tradeColors[role],
    lineWidth: role === 'entry' ? 2 : 1,
    lineStyle: LineStyle.Solid,
    lineVisible: true,
    axisLabelVisible: true,
    axisLabelColor: tradeColors[role],
    axisLabelTextColor: '#ffffff',
    title: name,
  };
}

function updateTradeLine(role: 'stopLoss' | 'takeProfit'): void {
  if (!trade) return;
  trade.lines[role].applyOptions(lineOptions(role, trade[role], trade.side));
}

function openTrade(side: PaperTradeSide): void {
  if (trade) {
    setStatus('Clear the current simulated trade before opening another.', true);
    return;
  }
  const bar = candles.dataByIndex(candles.data().length - 1, 0);
  if (!bar || !('close' in bar)) {
    setStatus('Market data is not ready; no simulated trade was created.', true);
    return;
  }

  const entry = bar.close;
  const protection = createProtectionLevels(side, entry);
  trade = {
    side,
    entry,
    ...protection,
    lines: {
      entry: candles.createPriceLine(lineOptions('entry', entry, side)),
      stopLoss: candles.createPriceLine(lineOptions('stopLoss', protection.stopLoss, side)),
      takeProfit: candles.createPriceLine(lineOptions('takeProfit', protection.takeProfit, side)),
    },
  };
  buyButton.disabled = true;
  sellButton.disabled = true;
  clearButton.disabled = false;
  setStatus(`Simulated ${side.toUpperCase()} at ${entry.toFixed(2)}. Drag SL/TP; entry is fixed.`);
}

function clearTrade(): void {
  if (!trade) return;
  for (const line of Object.values(trade.lines)) candles.removePriceLine(line);
  trade = null;
  dragging = null;
  buyButton.disabled = false;
  sellButton.disabled = false;
  clearButton.disabled = true;
  setStatus('Simulated trade cleared.');
}

function closestDraggableLevel(y: number): 'stopLoss' | 'takeProfit' | null {
  if (!trade) return null;
  let closest: { role: 'stopLoss' | 'takeProfit'; distance: number } | null = null;
  for (const role of ['stopLoss', 'takeProfit'] as const) {
    const coordinate = candles.priceToCoordinate(trade[role]);
    if (coordinate === null) continue;
    const distance = Math.abs(coordinate - y);
    if (distance <= 9 && (!closest || distance < closest.distance)) closest = { role, distance };
  }
  return closest?.role ?? null;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !trade) return;
  const rect = chartElement.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || x > rect.width - 64) return;
  const role = closestDraggableLevel(y);
  if (!role) return;

  dragging = role;
  chartElement.setPointerCapture(event.pointerId);
  chartElement.style.cursor = 'ns-resize';
  event.preventDefault();
  event.stopPropagation();
}

function onPointerMove(event: PointerEvent): void {
  if (!trade) return;
  const rect = chartElement.getBoundingClientRect();
  const y = event.clientY - rect.top;
  if (dragging) {
    const price = candles.coordinateToPrice(y);
    if (price === null || !Number.isFinite(price) || price <= 0) return;
    trade[dragging] = moveProtectionLevel(trade.side, dragging, trade.entry, price, minTick);
    updateTradeLine(dragging);
    setStatus(`Dragging ${dragging === 'stopLoss' ? 'SL' : 'TP'} to ${trade[dragging].toFixed(2)}.`);
    return;
  }
  const x = event.clientX - rect.left;
  chartElement.style.cursor = x >= 0 && x <= rect.width - 64 && closestDraggableLevel(y)
    ? 'ns-resize' : '';
}

function onPointerUp(): void {
  if (!dragging) return;
  dragging = null;
  chartElement.style.cursor = '';
  if (trade) {
    setStatus(
      `Simulated ${trade.side.toUpperCase()} updated. Entry ${trade.entry.toFixed(2)} · `
      + `SL ${trade.stopLoss.toFixed(2)} · TP ${trade.takeProfit.toFixed(2)}. Entry is fixed.`,
    );
  }
}

buyButton.addEventListener('click', () => openTrade('buy'));
sellButton.addEventListener('click', () => openTrade('sell'));
clearButton.addEventListener('click', clearTrade);
chartElement.addEventListener('pointerdown', onPointerDown, true);
chartElement.addEventListener('pointermove', onPointerMove, true);
chartElement.addEventListener('pointerup', onPointerUp, true);
chartElement.addEventListener('pointercancel', onPointerUp, true);
window.addEventListener('beforeunload', () => {
  unsubscribe?.();
  chart.remove();
});

async function start(): Promise<void> {
  try {
    const bars = await provider.getBars('BTCUSDT', '60', { limit: 500 });
    if (bars.length === 0) throw new Error('Binance returned no BTCUSDT candles.');
    candles.setData(bars.map(bar => ({
      time: Math.floor(bar.time / 1000) as Time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })));
    chart.timeScale().fitContent();
    unsubscribe = provider.subscribe('BTCUSDT', '60', bar => {
      candles.update({
        time: Math.floor(bar.time / 1000) as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
    });
    setStatus(`Loaded ${bars.length} BTCUSDT hourly candles; live updates via Binance.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Could not load prototype market data: ${message}`, true);
    console.error('Lightweight Charts prototype failed to load data:', error);
  }
}

void start();
