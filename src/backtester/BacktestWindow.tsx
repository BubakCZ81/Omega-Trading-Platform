import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, Download, FastForward, LoaderCircle, Maximize2, Minimize2, Pause, Play, Rewind, SkipBack, SkipForward, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { AssetInfo, CandleBar, Timeframe } from './types.ts';
import { getPineBacktestSchema, type PineBacktestResult } from './backtester.ts';
import { visibleReplayPoints } from './replayPlots.ts';
import { runPineBacktestInWorker } from './backtestWorkerClient.ts';
import { normalizeBacktestTimeframe } from './timeframe.ts';
import { PINE_SAMPLES } from './samples.ts';
import type { InputSchema, InputValue, StrategyTrade } from '@luxalgo/vela';
import { createHeikinTransform } from '../heikinMath';

interface BacktestWindowProps {
  open: boolean;
  source: string;
  candles: CandleBar[];
  symbol: string;
  timeframe: Timeframe;
  assets: AssetInfo[];
  loadHistory: (symbol: string, timeframe: string, from: number, to: number, onProgress?: (loadedBars: number) => void) => Promise<CandleBar[]>;
  onClose: () => void;
}

interface SavedScript { name: string; group: string; path: string; code: string; }
interface ScriptOption { name: string; code: string; id: string; }
interface PlotLine { name: string; points: { time: number; value: number }[]; overlay: boolean; color: string; }
type ReplayTradeState = 'Pending' | 'Open' | 'Closed';

function tradeAtCursor(trade: StrategyTrade, bars: CandleBar[], cursor: number) {
  const cursorBar = bars[cursor];
  const cursorTime = cursorBar ? Math.round(cursorBar.time * 1000) : -Infinity;
  if (trade.entry.time > cursorTime) return { state: 'Pending' as ReplayTradeState, pnl: undefined };
  if (trade.exit && trade.exit.time <= cursorTime) return { state: 'Closed' as ReplayTradeState, pnl: trade.pnl };
  if (!cursorBar) return { state: 'Pending' as ReplayTradeState, pnl: undefined };
  const direction = trade.side === 'long' ? 1 : -1;
  const unrealized = (cursorBar.close - trade.entry.price) * trade.qty * direction - (trade.open ? trade.commission ?? 0 : 0);
  return { state: 'Open' as ReplayTradeState, pnl: unrealized };
}

const SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 30, 60];
const TIMEFRAME_GROUPS: Array<{ label: string; unit: string; values: number[] }> = [
  { label: 'Seconds', unit: 's', values: [1, 5, 10, 15, 30, 45] },
  { label: 'Minutes', unit: 'm', values: [1, 2, 3, 5, 10, 15, 20, 30, 45, 60] },
  { label: 'Hours', unit: 'h', values: [1, 2, 3, 4, 6, 8, 12, 24] },
  { label: 'Days', unit: 'D', values: [1, 2, 3, 5] },
  { label: 'Weeks', unit: 'W', values: [1, 2, 4] },
  { label: 'Months', unit: 'M', values: [1, 3, 6, 12] },
  { label: 'Ticks', unit: 't', values: [1, 10, 100, 1000] },
];
const HEIKIN_ASHI_PERIODS = [1, 2, 3, 4, 5, 6, 10, 15, 20, 30, 45];
const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const toLocalInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const schemaDefaults = (schema: InputSchema[]) => Object.fromEntries(schema.map((item) => [item.key, item.defval]));

function SettingField({ schema, value, onChange }: { schema: InputSchema; value: InputValue; onChange: (value: InputValue) => void }) {
  const cls = 'mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-blue-400';
  if (schema.type === 'bool') return <label className="flex items-center gap-2 rounded border border-slate-700 bg-slate-950/60 px-2 py-2 text-xs text-slate-200"><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />{schema.title}</label>;
  if (schema.options?.length) return <label className="block min-w-0 text-[10px] text-slate-400">{schema.title}<select className={cls} value={String(value)} onChange={(event) => onChange(event.target.value)}>{schema.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
  if (schema.type === 'text_area') return <label className="block min-w-0 text-[10px] text-slate-400">{schema.title}<textarea className={cls} rows={2} value={String(value)} onChange={(event) => onChange(event.target.value)} /></label>;
  if (['int', 'float', 'price', 'time'].includes(schema.type)) return <label className="block min-w-0 text-[10px] text-slate-400">{schema.title}<input className={cls} type="number" min={schema.min} max={schema.max} step={schema.step ?? (schema.type === 'int' ? 1 : 'any')} value={Number(value)} onChange={(event) => onChange(Number(event.target.value))} /></label>;
  return <label className="block min-w-0 text-[10px] text-slate-400">{schema.title}<input className={cls} type="text" value={String(value)} onChange={(event) => onChange(event.target.value)} /></label>;
}

const EquityCurve = React.memo(function EquityCurve({ result }: { result: PineBacktestResult | null }) {
  const points = useMemo(() => result?.equity.map((point) => ({ value: point.equity, time: point.time })) ?? [], [result]);
  if (points.length < 2) return <div className="grid h-full min-h-36 place-items-center p-6 text-center text-sm text-slate-400">Run a Pine strategy to see its closed-trade equity curve.</div>;
  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const span = max - min || 1;
  const d = points.map((point, index) => `${index ? 'L' : 'M'}${20 + index / (points.length - 1) * 960},${180 - (point.value - min) / span * 150}`).join(' ');
  const up = points.at(-1)!.value >= points[0].value;
  return <div className="h-full min-h-36 p-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-medium text-slate-200">Per-bar equity · includes open-position value</span><span className={`font-mono font-semibold ${up ? 'text-emerald-300' : 'text-rose-300'}`}>{money(points.at(-1)!.value)} · {pct((points.at(-1)!.value - points[0].value) / Math.max(1, points[0].value) * 100)}</span></div>
    <svg className="h-[calc(100%-28px)] min-h-28 w-full" viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-label="Strategy equity curve">
      {[0, 1, 2, 3].map((line) => <line key={line} x1="20" x2="980" y1={15 + line * 50} y2={15 + line * 50} stroke="var(--omega-border)" strokeDasharray="3 5"/>)}
      <path d={d} fill="none" stroke={up ? '#34d399' : '#fb7185'} strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>
      <text x="20" y="196" fill="var(--omega-muted)" fontSize="10">{points.length} bars · marked to market</text>
    </svg>
  </div>;
});

function ReplayChart({ bars, cursor, plots, trades, viewportBars }: { bars: CandleBar[]; cursor: number; plots: PlotLine[]; trades: PineBacktestResult['trades']; viewportBars: number }) {
  const windowStart = Math.max(0, cursor - viewportBars + 1);
  const shown = useMemo(() => bars.slice(windowStart, Math.max(0, cursor + 1)), [bars, cursor, windowStart]);
  const display = useMemo(() => {
    if (!shown.length) return null;
    const startTime = Math.round(shown[0].time * 1000);
    const replayTime = Math.round(shown.at(-1)!.time * 1000);
    const visiblePlots = plots.map(plot => ({
      ...plot, points: visibleReplayPoints(plot.points, startTime, replayTime),
    }));
    const indexForTime = (timeMs: number) => {
      if (timeMs < startTime || timeMs > replayTime) return -1;
      let lowIndex = 0; let highIndex = shown.length - 1;
      while (lowIndex < highIndex) { const middle = Math.ceil((lowIndex + highIndex) / 2); if (Math.round(shown[middle].time * 1000) <= timeMs) lowIndex = middle; else highIndex = middle - 1; }
      return lowIndex;
    };
    const visibleTrades = trades.flatMap((trade) => {
      const entryIndex = indexForTime(trade.entry.time);
      const exitIndex = trade.exit ? indexForTime(trade.exit.time) : -1;
      const isOpenAtCursor = trade.entry.time <= replayTime && (!trade.exit || trade.exit.time > replayTime);
      return entryIndex >= 0 ? [{ trade, entryIndex, exitIndex, isOpenAtCursor }] : [];
    });
    const priceValues = shown.flatMap((bar) => [bar.low, bar.high]);
    const overlays = visiblePlots.filter(plot => plot.overlay);
    for (const plot of overlays) for (const point of plot.points) priceValues.push(point.value);
    visibleTrades.forEach(({ trade, exitIndex }) => {
      priceValues.push(trade.entry.price);
      // Only scale to exits reached by this replay point; future fills must not
      // pull the active chart's autoscale away from the visible candles.
      if (trade.exit && exitIndex >= 0) priceValues.push(trade.exit.price);
    });
    const low = Math.min(...priceValues); const high = Math.max(...priceValues); const span = high - low || Math.max(Math.abs(high) * 0.001, 1);
    const left = 54; const right = 72; const top = 20; const plotBottom = 354; const paneTop = 390; const paneBottom = 480;
    const width = 1200 - left - right; const candleWidth = Math.max(0.75, Math.min(12, width / Math.max(1, viewportBars) * 0.62));
    // Keep the latest candle pinned at the right edge. The viewport can contain
    // more slots than available candles, so zoom-out still works at cursor 0.
    const slotOffset = Math.max(0, viewportBars - shown.length);
    const x = (index: number) => left + (slotOffset + index + 0.5) / Math.max(1, viewportBars) * width;
    const y = (value: number) => top + (high - value) / span * (plotBottom - top);
    const subPlots = visiblePlots.filter((plot) => !plot.overlay);
    const subValues = subPlots.flatMap((plot) => plot.points.map((point) => point.value));
    const subLow = subValues.length ? Math.min(...subValues) : 0; const subHigh = subValues.length ? Math.max(...subValues) : 1; const subSpan = subHigh - subLow || 1;
    return { shown, left, right, top, plotBottom, paneTop, paneBottom, width, candleWidth, low, high, x, y, indexForTime, overlays, subPlots, subLow, subSpan, visibleTrades };
  }, [shown, plots, trades, viewportBars]);

  if (!display) return <div className="grid h-full place-items-center text-xs text-slate-500">Load history and run the selected script to start visual playback.</div>;
  const { shown: visible, left, right, top, plotBottom, paneTop, paneBottom, candleWidth, x, y, indexForTime, overlays, subPlots, subLow, subSpan, visibleTrades } = display;
  const renderPlot = (plot: PlotLine, lower: boolean) => {
    const plotY = lower
      ? (value: number) => paneBottom - ((value - subLow) / subSpan) * (paneBottom - paneTop)
      : y;
    if (plot.points.length === 1) {
      const point = plot.points[0];
      return <circle key={plot.name} cx={x(indexForTime(point.time))} cy={plotY(point.value)} r="2" fill={plot.color}/>;
    }
    const path = plot.points.map((point, index) =>
      `${index ? 'L' : 'M'}${x(indexForTime(point.time)).toFixed(2)},${plotY(point.value).toFixed(2)}`,
    ).join(' ');
    return <path key={plot.name} d={path} fill="none" stroke={plot.color} strokeWidth={lower ? 1.5 : 1.7} vectorEffect="non-scaling-stroke"/>;
  };
  const last = visible.at(-1)!;
  return <div className="vela-backtest-chart relative min-h-[300px] flex-1 overflow-hidden rounded-lg border border-slate-700">
    <svg className="h-full min-h-[300px] w-full" viewBox="0 0 1200 510" preserveAspectRatio="none" role="img" aria-label="Visual candle-by-candle backtest chart">
      {[0, 1, 2, 3, 4].map((index) => <g key={index}><line x1={left} x2={1200 - right} y1={top + index * ((plotBottom - top) / 4)} y2={top + index * ((plotBottom - top) / 4)} stroke="var(--app-border)" strokeDasharray="3 5"/><text x={1200 - right + 8} y={top + index * ((plotBottom - top) / 4) + 4} fill="var(--muted-text)" fontSize="10">{(display.high - index * ((display.high - display.low) / 4)).toPrecision(6)}</text></g>)}
      <line x1={left} x2={1200 - right} y1={plotBottom} y2={plotBottom} stroke="var(--app-border)"/>
      {visible.map((bar, index) => { const center = x(index); const up = bar.close >= bar.open; const color = up ? '#26a69a' : '#ef5350'; const bodyTop = y(Math.max(bar.open, bar.close)); const bodyHeight = Math.max(1, Math.abs(y(bar.open) - y(bar.close))); return <g key={windowStart + index}><line x1={center} x2={center} y1={y(bar.high)} y2={y(bar.low)} stroke={color} strokeWidth="1"/><rect x={center - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} fill={color}/></g>; })}
      {overlays.map((plot) => renderPlot(plot, false))}
      {visibleTrades.map(({ trade, entryIndex, exitIndex, isOpenAtCursor }) => <g key={`${trade.id}-${entryIndex}`}><title>{`${trade.side.toUpperCase()} ${trade.open ? 'open' : isOpenAtCursor ? 'open at replay point' : 'closed'} · ${trade.entry.comment || trade.entry.id || trade.id} · entry @ ${trade.entry.price}${trade.exit ? ` · exit @ ${trade.exit.price} · P&L ${money(trade.pnl ?? 0)}` : ''}`}</title>{isOpenAtCursor && <line x1={x(entryIndex)} x2={1200 - right - 3} y1={y(trade.entry.price)} y2={y(trade.entry.price)} stroke={trade.side === 'long' ? '#22c55e' : '#fb7185'} strokeWidth="1.5" strokeDasharray="6 4" opacity=".8"/>}<circle cx={x(entryIndex)} cy={y(trade.entry.price)} r="5" fill={trade.side === 'long' ? '#22c55e' : '#fb7185'} stroke="var(--app-bg)" strokeWidth="2"/>{exitIndex >= 0 && <circle cx={x(exitIndex)} cy={y(trade.exit!.price)} r="4" fill="#fbbf24" stroke="var(--app-bg)" strokeWidth="2"/>}</g>)}
      {subPlots.length > 0 && <g><rect x={left} y={paneTop} width={1200 - left - right} height={paneBottom - paneTop} fill="var(--surface-2)" stroke="var(--app-border)"/><text x={left + 8} y={paneTop + 13} fill="var(--muted-text)" fontSize="10">Indicator pane · {subPlots.map((plot) => plot.name).join(', ')}</text>{subPlots.map((plot) => renderPlot(plot, true))}</g>}
      <text x={left} y="500" fill="var(--muted-text)" fontSize="10">{new Date(visible[0].time * 1000).toLocaleString()}</text><text x={1200 - right - 150} y="500" fill="var(--app-text)" fontSize="11">{new Date(last.time * 1000).toLocaleString()} · {last.close}</text>
    </svg>
    <div className="absolute left-3 right-3 top-2 flex flex-wrap gap-1.5 text-[10px]">{plots.map((plot) => <span key={plot.name} title={plot.name} className="min-w-0 max-w-[min(45%,320px)] truncate rounded bg-slate-950/90 px-2 py-1 text-slate-200"><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: plot.color }}/>{plot.name}</span>)}</div>
  </div>;
}

export const BacktestWindow: React.FC<BacktestWindowProps> = ({ open, source, candles: initialCandles, symbol: initialSymbol, timeframe: initialTimeframe, assets, loadHistory, onClose }) => {
  const [result, setResult] = useState<PineBacktestResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyBarsLoaded, setHistoryBarsLoaded] = useState(0);
  const [selectedSymbol, setSelectedSymbol] = useState(initialSymbol);
  const [selectedTimeframe, setSelectedTimeframe] = useState<string>(() => normalizeBacktestTimeframe(initialTimeframe));
  const [heikinAshi, setHeikinAshi] = useState(false);
  const [visualPlayback, setVisualPlayback] = useState(true);
  const [scriptSettingsOpen, setScriptSettingsOpen] = useState(false);
  const [scriptSettingsHeightVh, setScriptSettingsHeightVh] = useState(20);
  const [timeframePickerOpen, setTimeframePickerOpen] = useState(false);
  const [customTimeframeAmount, setCustomTimeframeAmount] = useState('34');
  const [customTimeframeUnit, setCustomTimeframeUnit] = useState('m');
  const [fromDate, setFromDate] = useState(() => toLocalInput(new Date(Date.now() - 30 * 86400000)));
  const [toDate, setToDate] = useState(() => toLocalInput(new Date()));
  const [savedScripts] = useState<SavedScript[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('vela_user_scripts') || '{}') as Record<string, unknown>;
      return Object.entries(parsed).flatMap(([name, code]) => typeof code === 'string' ? [{ name, group: 'Omega scripts', path: name, code }] : []);
    } catch { return []; }
  });
  const [scriptIndex, setScriptIndex] = useState('__current__');
  const scriptOptions = useMemo<ScriptOption[]>(() => [
    { id: '__current__', name: 'Current editor script', code: source },
    ...PINE_SAMPLES.map((sample) => ({ id: `sample:${sample.id}`, name: `${sample.name} · built-in`, code: sample.code })),
    ...savedScripts.map((script) => ({ id: script.path, name: `${script.name} · ${script.group}`, code: script.code })),
  ], [source, savedScripts]);
  const selectedScript = scriptOptions.find((script) => script.id === scriptIndex) ?? scriptOptions[0];
  const [schemas, setSchemas] = useState<{ inputs: InputSchema[]; properties: InputSchema[] }>({ inputs: [], properties: [] });
  const [inputValues, setInputValues] = useState<Record<string, InputValue>>({});
  const [propertyValues, setPropertyValues] = useState<Record<string, InputValue>>({});
  const [bars, setBars] = useState<CandleBar[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pane, setPane] = useState<'trades' | 'equity' | 'statistics'>('trades');
  const [maximized, setMaximized] = useState(false);
  const [viewportBars, setViewportBars] = useState(80);
  const [chartPaneShare, setChartPaneShare] = useState(58);
  const backtestWindowRef = useRef<HTMLElement>(null);
  const settingsSplitRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const splitLayoutRef = useRef<HTMLDivElement>(null);
  const splitPointerRef = useRef<number | null>(null);

  useEffect(() => { if (!open) return; let active = true; void getPineBacktestSchema(selectedScript.code).then((schema) => { if (!active) return; setSchemas(schema); setInputValues(schemaDefaults(schema.inputs)); setPropertyValues(schemaDefaults(schema.properties)); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }); return () => { active = false; }; }, [open, selectedScript.code]);
  useEffect(() => {
    if (!playing) return;
    if (cursor >= bars.length - 1) {
      setPlaying(false);
      return;
    }
    // Schedule one step per committed render so a slow frame cannot queue more candles.
    const timer = window.setTimeout(() => setCursor(index => Math.min(bars.length - 1, index + 1)), 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, cursor, bars.length, speed]);
  useEffect(() => { setSelectedSymbol(initialSymbol); setSelectedTimeframe(normalizeBacktestTimeframe(initialTimeframe)); setHeikinAshi(false); }, [initialSymbol, initialTimeframe]);
  if (!open) return null;

  const loadAndRun = async () => {
    setRunning(true); setLoadingHistory(false); setHistoryBarsLoaded(0); setPlaying(false); setError(''); setResult(null); setBars([]); setCursor(-1);
    try {
      const from = new Date(fromDate).getTime(); const to = new Date(toDate).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Choose a valid date range. The end must be later than the start.');
      const timeframe = normalizeBacktestTimeframe(selectedTimeframe);
      if (!/^\d+(?:s|m|h|D|W|M|t)$/i.test(timeframe)) throw new Error('Enter a supported timeframe such as 15s, 34m, 2h, 1D, or 100t.');
      setLoadingHistory(true);
      let history: CandleBar[] = await loadHistory(selectedSymbol, timeframe, from, to, setHistoryBarsLoaded);
      setLoadingHistory(false);
      history = history.map((bar) => ({ ...bar, time: bar.time > 1e12 ? bar.time / 1000 : bar.time }));
      if (history.length < 2 && selectedSymbol === initialSymbol && timeframe === normalizeBacktestTimeframe(initialTimeframe)) history = initialCandles.filter((bar) => bar.time * 1000 >= from && bar.time * 1000 <= to);
      if (history.length < 2) throw new Error('No historical candles found for that asset, timeframe, and date range. Connect a compatible data source or widen the range.');
      if (heikinAshi) history = createHeikinTransform(0, 5).full(history);
      setBars(history);
      const nextResult = await runPineBacktestInWorker(selectedScript.code, history, selectedSymbol, timeframe as Timeframe, { inputs: inputValues, props: propertyValues });
      setResult(nextResult); setCursor(history.length - 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingHistory(false); setRunning(false); }
  };

  const strategy = result?.context.strategy;
  const plots = useMemo<PlotLine[]>(() => result ? Object.entries(result.context.plots).map(([name, points], index) => ({ name, points: points.flatMap((point) => typeof point.value === 'number' && Number.isFinite(point.value) ? [{ time: point.time, value: point.value }] : []).sort((a, b) => a.time - b.time), overlay: result.context.meta.overlay, color: ['#38bdf8', '#a78bfa', '#fbbf24', '#fb7185', '#34d399', '#f97316'][index % 6] })) : [], [result]);
  const closedTrades = result?.trades.filter((trade) => !trade.open && trade.pnl != null) ?? [];
  const visibleTrades = result?.trades.filter((trade) => cursor >= 0 && trade.entry.time <= Math.round((bars[cursor]?.time ?? 0) * 1000)) ?? [];
  const openTradesAtCursor = visibleTrades.filter((trade) => tradeAtCursor(trade, bars, cursor).state === 'Open').length;
  const exportCsv = () => { if (!result) return; const rows = [['id', 'side', 'quantity', 'entry_time', 'entry_price', 'exit_time', 'exit_price', 'pnl', 'commission'], ...result.trades.map((trade) => [trade.id, trade.side, trade.qty, new Date(trade.entry.time).toISOString(), trade.entry.price, trade.exit ? new Date(trade.exit.time).toISOString() : '', trade.exit?.price ?? '', trade.pnl ?? '', trade.commission ?? ''])]; const blob = new Blob([rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')], { type: 'text/csv' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `vela-backtest-${selectedSymbol}-${selectedTimeframe}.csv`; link.click(); URL.revokeObjectURL(url); };
  const updateValue = (setter: React.Dispatch<React.SetStateAction<Record<string, InputValue>>>, key: string, value: InputValue) => setter((previous) => ({ ...previous, [key]: value }));
  const resizeSplit = (event: React.PointerEvent<HTMLDivElement>) => {
    if (splitPointerRef.current !== event.pointerId || !splitLayoutRef.current) return;
    const rect = splitLayoutRef.current.getBoundingClientRect();
    if (rect.height <= 0) return;
    setChartPaneShare(Math.max(28, Math.min(80, (event.clientY - rect.top) / rect.height * 100)));
  };
  const resizeScriptSettings = (event: React.PointerEvent<HTMLDivElement>) => {
    if (settingsSplitRef.current?.pointerId !== event.pointerId || !backtestWindowRef.current) return;
    const rect = backtestWindowRef.current.getBoundingClientRect();
    if (rect.height <= 0) return;
    const deltaVh = (event.clientY - settingsSplitRef.current.startY) / window.innerHeight * 100;
    setScriptSettingsHeightVh(Math.max(10, Math.min(50, settingsSplitRef.current.startHeight + deltaVh)));
  };
  const toggleMaximize = async () => {
    const desktop = (window as Window & { velaDesktop?: { toggleMaximizeCurrentWindow?: () => Promise<boolean> } }).velaDesktop;
    if (desktop?.toggleMaximizeCurrentWindow) {
      setMaximized(await desktop.toggleMaximizeCurrentWindow());
      return;
    }
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); setMaximized(false); }
      else { await document.documentElement.requestFullscreen(); setMaximized(true); }
    } catch { /* Browser fullscreen may be unavailable; the window remains resizable. */ }
  };

  return <div className="vela-backtest-root fixed inset-0 z-[12000] flex items-center justify-center p-2 text-slate-100 sm:p-3" role="presentation">
    <section ref={backtestWindowRef} role="dialog" aria-modal="true" aria-label="Visual backtester" className="flex h-full w-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-700 px-3 py-2.5 sm:px-4"><div className="flex min-w-0 items-center gap-2"><span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-blue-500/15 text-blue-300"><Activity size={17}/></span><div className="min-w-0"><h1 className="truncate text-sm font-semibold">Pine Backtest Runner</h1><p className="text-[10px] text-slate-400">PineTS historical execution · local simulation only</p></div></div><div className="flex shrink-0 items-center gap-2">{result && <button onClick={exportCsv} className="hidden items-center gap-1.5 rounded border border-slate-600 px-2.5 py-1.5 text-[11px] hover:bg-slate-800 sm:flex"><Download size={13}/>Export trades</button>}<button type="button" onClick={() => void toggleMaximize()} aria-label={maximized ? 'Restore backtester window' : 'Maximize backtester window'} title={maximized ? 'Restore window' : 'Maximize window'} className="rounded p-2 text-slate-400 hover:bg-slate-800 hover:text-white">{maximized ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button><button onClick={onClose} aria-label="Close backtester" className="rounded p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><X size={17}/></button></div></header>
      <section className="grid shrink-0 grid-cols-2 gap-2 border-b border-slate-700 bg-slate-900/90 p-2 sm:grid-cols-4 xl:grid-cols-10">
        <label className="min-w-0 text-[10px] text-white">Asset<select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value)} className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-xs text-slate-100">{assets.map((asset) => <option key={asset.symbol} value={asset.symbol} className="bg-white text-black">{asset.symbol} · {asset.name}</option>)}</select></label>
        <div className="relative min-w-0 text-[10px] text-white">
          <span>Timeframe</span>
          <button type="button" aria-label="Choose backtest timeframe" aria-expanded={timeframePickerOpen} onClick={() => setTimeframePickerOpen((value) => !value)} className="mt-1 flex w-full items-center justify-between rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"><span>{selectedTimeframe}{heikinAshi ? ' · Heikin Ashi' : ''}</span><ChevronDown size={13}/></button>
          {timeframePickerOpen && <div className="absolute left-0 top-full z-[13000] mt-1 w-[min(760px,92vw)] max-h-[min(78vh,44rem)] overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 p-3 shadow-2xl sm:p-4">
            <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 pb-3">
              <div><h2 className="text-xs font-semibold tracking-wide text-white">Choose timeframe</h2><p className="mt-1 text-[10px] text-slate-400">Choose a category, then select one value.</p></div>
              <span className="rounded-full border border-blue-400/30 bg-blue-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold text-blue-200">{heikinAshi ? 'Heikin Ashi · ' : ''}{selectedTimeframe}</span>
            </header>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {TIMEFRAME_GROUPS.map((group) => {
                const selectedValue = !heikinAshi && selectedTimeframe.endsWith(group.unit) ? selectedTimeframe : '';
                return <label key={group.unit} className="timeframe-category min-w-0 rounded-lg border border-slate-700 bg-slate-950/70 p-2.5 text-xs text-slate-100">
                  <span className="mb-1.5 flex items-center justify-between gap-2 font-semibold"><span>{group.label}</span><span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">{group.values.length}</span></span>
                  <select aria-label={`${group.label} timeframe`} value={selectedValue} onChange={(event) => { if (!event.target.value) return; setSelectedTimeframe(event.target.value); setHeikinAshi(false); setTimeframePickerOpen(false); }} className="w-full rounded-md border border-slate-600 bg-white px-2.5 py-2 text-[11px] font-medium text-black outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30">
                    <option value="" className="bg-white text-black">Choose {group.label.toLowerCase()}…</option>
                    {group.values.map((value) => { const key = `${value}${group.unit}`; return <option key={key} value={key} className="bg-white text-black">{key}</option>; })}
                  </select>
                </label>;
              })}
              <label className="timeframe-category timeframe-category--heikin min-w-0 rounded-lg border border-violet-400/40 bg-violet-950/20 p-2.5 text-xs text-violet-100">
                <span className="mb-1.5 flex items-center justify-between gap-2 font-semibold"><span>Heikin Ashi</span><span className="rounded bg-violet-900/60 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">{HEIKIN_ASHI_PERIODS.length}</span></span>
                <select aria-label="Heikin Ashi timeframe" value={heikinAshi ? selectedTimeframe : ''} onChange={(event) => { if (!event.target.value) return; setSelectedTimeframe(event.target.value); setHeikinAshi(true); setTimeframePickerOpen(false); }} className="w-full rounded-md border border-violet-400/60 bg-white px-2.5 py-2 text-[11px] font-medium text-black outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30">
                  <option value="" className="bg-white text-black">Choose Heikin Ashi…</option>
                  {HEIKIN_ASHI_PERIODS.map((minutes) => <option key={minutes} value={`${minutes}m`} className="bg-white text-black">{minutes} minute{minutes === 1 ? '' : 's'}</option>)}
                </select>
              </label>
            </div>
            <form className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-700 pt-3" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); const amount = Number(customTimeframeAmount); if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return; setSelectedTimeframe(`${amount}${customTimeframeUnit}`); setHeikinAshi(false); setTimeframePickerOpen(false); }}>
              <label className="text-[9px] text-slate-400">Custom interval<input type="text" inputMode="numeric" autoComplete="off" value={customTimeframeAmount} onChange={(event) => setCustomTimeframeAmount(event.currentTarget.value)} className="mt-1 block w-28 rounded border border-slate-600 bg-white px-2 py-2 text-[11px] text-black outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30" /></label>
              <label className="text-[9px] text-slate-400">Unit<select value={customTimeframeUnit} onChange={(event) => setCustomTimeframeUnit(event.target.value)} className="mt-1 block rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-xs text-white">{[['s', 'Seconds'], ['m', 'Minutes'], ['h', 'Hours'], ['D', 'Days'], ['W', 'Weeks'], ['M', 'Months'], ['t', 'Ticks']].map(([value, name]) => <option key={value} value={value} className="bg-white text-black">{name}</option>)}</select></label>
              <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-[10px] font-semibold text-white">Use custom</button><button type="button" onClick={() => setTimeframePickerOpen(false)} className="rounded border border-slate-700 px-3 py-1.5 text-[10px] text-slate-300">Close</button>
            </form>
          </div>}
        </div>
        <label className="min-w-0 text-[10px] text-white">From<input type="datetime-local" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-100" /></label>
        <label className="min-w-0 text-[10px] text-white">To<input type="datetime-local" value={toDate} onChange={(event) => setToDate(event.target.value)} className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-100" /></label>
        <label className="col-span-2 min-w-0 text-[10px] text-white sm:col-span-2 xl:col-span-2">Strategy / indicator<select value={scriptIndex} onChange={(event) => { setScriptIndex(event.target.value); setResult(null); }} className="mt-1 w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-xs text-slate-100">{scriptOptions.map((script) => <option key={script.id} value={script.id} className="bg-white text-black">{script.name}</option>)}</select></label>
        <label className="col-span-2 flex min-w-0 items-center gap-2 self-end rounded border border-slate-700 bg-slate-950/60 px-2 py-2 text-[11px] text-slate-200 xl:col-span-2"><input type="checkbox" checked={visualPlayback} onChange={(event) => setVisualPlayback(event.target.checked)} className="accent-blue-500"/><span><span className="block font-medium text-slate-100">Visual playback</span><span className="block text-[9px] text-slate-400">Render candles and replay controls</span></span></label>
        <button type="button" disabled={running} onClick={() => void loadAndRun()} className="col-span-2 flex items-center justify-center gap-2 self-end rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60 sm:col-span-2 xl:col-span-2">{running ? <LoaderCircle className="animate-spin" size={14}/> : <Play size={14}/>} {running ? 'Loading & running…' : visualPlayback ? 'Load history & run' : 'Run fast backtest'}</button>
      </section>
      {(schemas.inputs.length > 0 || schemas.properties.length > 0) && <details open={scriptSettingsOpen} onToggle={(event) => setScriptSettingsOpen(event.currentTarget.open)} style={scriptSettingsOpen ? { height: `${scriptSettingsHeightVh}vh`, maxHeight: '50vh' } : undefined} className="shrink-0 overflow-auto border-b border-slate-700 bg-slate-950/50 px-3 py-2"><summary className="cursor-pointer text-[11px] font-medium text-slate-300">Script settings · {schemas.inputs.length} inputs · {schemas.properties.length} properties</summary><div className="grid grid-cols-2 gap-2 overflow-y-auto pt-2 sm:grid-cols-4 xl:grid-cols-6">{schemas.properties.map((field) => <SettingField key={`prop-${field.key}`} schema={field} value={propertyValues[field.key] ?? field.defval} onChange={(value) => updateValue(setPropertyValues, field.key, value)}/>)}{schemas.inputs.map((field) => <SettingField key={`input-${field.key}`} schema={field} value={inputValues[field.key] ?? field.defval} onChange={(value) => updateValue(setInputValues, field.key, value)}/>)}</div></details>}
      {scriptSettingsOpen && (schemas.inputs.length > 0 || schemas.properties.length > 0) && <div role="separator" aria-label="Resize script settings and backtest workspace" aria-orientation="horizontal" aria-valuenow={Math.round(scriptSettingsHeightVh)} aria-valuemin={10} aria-valuemax={50} tabIndex={0} onPointerDown={(event) => { settingsSplitRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: scriptSettingsHeightVh }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeScriptSettings} onPointerUp={(event) => { settingsSplitRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onKeyDown={(event) => { if (event.key === 'ArrowDown') setScriptSettingsHeightVh((height) => Math.min(50, height + 2)); if (event.key === 'ArrowUp') setScriptSettingsHeightVh((height) => Math.max(10, height - 2)); }} className="z-10 h-2 shrink-0 cursor-row-resize touch-none border-y border-slate-700 bg-slate-800 hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400" />}
      {error && <div role="alert" className="shrink-0 border-b border-rose-800 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">{error}</div>}
      <div ref={splitLayoutRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {loadingHistory && <div role="status" aria-live="polite" className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-slate-950/30"><div className="flex items-center gap-3 rounded-lg border border-slate-600 bg-slate-900/95 px-5 py-4 text-sm font-medium text-white shadow-xl"><LoaderCircle className="animate-spin text-blue-300" size={20}/><span>Loading history · {historyBarsLoaded.toLocaleString()} bars loaded</span></div></div>}
      {visualPlayback && <>
      <div className="flex min-h-[210px] flex-col p-2 pb-1 sm:p-3" style={{ flex: `${chartPaneShare} 1 0%` }}><div className="mb-2 flex shrink-0 flex-wrap items-center gap-2"><button type="button" disabled={!result || cursor <= 0} onClick={() => { setPlaying(false); setCursor(0); }} title="Reset playback" className="grid h-10 w-10 place-items-center rounded border border-slate-700 text-slate-300 disabled:opacity-40"><SkipBack size={18}/></button><button type="button" disabled={!result || cursor <= 0} onClick={() => { setPlaying(false); setCursor((index) => Math.max(0, index - 1)); }} title="Previous candle" className="grid h-10 w-10 place-items-center rounded border border-slate-700 text-slate-300 disabled:opacity-40"><Rewind size={18}/></button><button type="button" disabled={!result} onClick={() => setPlaying((value) => !value)} title={playing ? 'Pause' : 'Play'} className="grid h-10 w-10 place-items-center rounded bg-blue-600 text-white disabled:opacity-40">{playing ? <Pause size={18}/> : <Play size={18}/>}</button><button type="button" disabled={!result || cursor >= bars.length - 1} onClick={() => { setPlaying(false); setCursor((index) => Math.min(bars.length - 1, index + 1)); }} title="Next candle" className="grid h-10 w-10 place-items-center rounded border border-slate-700 text-slate-300 disabled:opacity-40"><SkipForward size={18}/></button><button type="button" disabled={!result} onClick={() => setSpeed((value) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(value) + 1)])} title="Increase playback speed" className="grid h-10 w-10 w-10 place-items-center rounded border border-slate-700 text-slate-300 disabled:opacity-40"><FastForward size={18}/></button><div className="flex items-center gap-1 rounded border border-slate-700 p-0.5"><button type="button" aria-label="Zoom out replay chart" title="Zoom out" onClick={() => setViewportBars((count) => Math.min(1000, count * 2))} disabled={viewportBars >= 1000} className="grid h-8 w-8 place-items-center rounded text-slate-300 hover:bg-slate-800 disabled:opacity-40"><ZoomOut size={16}/></button><span className="min-w-12 text-center font-mono text-[10px] text-slate-400">{viewportBars} bars</span><button type="button" aria-label="Zoom in replay chart" title="Zoom in" onClick={() => setViewportBars((count) => Math.max(1, Math.floor(count / 2)))} disabled={viewportBars <= 1} className="grid h-8 w-8 place-items-center rounded text-slate-300 hover:bg-slate-800 disabled:opacity-40"><ZoomIn size={16}/></button></div><label className="text-[10px] text-slate-400">Speed <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} className="ml-1 rounded border border-slate-400 bg-white px-2 py-1 text-xs text-black">{SPEEDS.map((value) => <option key={value} value={value} className="bg-white text-black">{value}×</option>)}</select></label><span className="ml-auto min-w-0 max-w-full truncate text-[10px] text-slate-400">{cursor < 0 ? 'Not started' : `${cursor + 1} / ${bars.length} bars`} {bars[cursor] && `· ${new Date(bars[cursor].time * 1000).toLocaleString()}`}</span></div>
        <div className="min-h-0 flex-1"><ReplayChart bars={bars} cursor={cursor} plots={plots} trades={result?.trades ?? []} viewportBars={viewportBars}/></div>
        <div className="mt-2 flex shrink-0 items-center gap-2"><input aria-label="Replay position" type="range" min={0} max={Math.max(0, bars.length - 1)} value={Math.max(0, cursor)} disabled={!result} onChange={(event) => { setPlaying(false); setCursor(Number(event.target.value)); }} className="w-full accent-blue-500"/><span className="w-20 text-right font-mono text-[10px] text-slate-400">{bars.length ? `${Math.round(Math.max(0, cursor) / Math.max(1, bars.length - 1) * 100)}%` : '—'}</span></div>
      </div>
      <div role="separator" aria-label="Resize chart and backtest results" aria-orientation="horizontal" aria-valuenow={Math.round(chartPaneShare)} aria-valuemin={28} aria-valuemax={80} tabIndex={0} onPointerDown={(event) => { splitPointerRef.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeSplit} onPointerUp={(event) => { splitPointerRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onKeyDown={(event) => { if (event.key === 'ArrowUp') setChartPaneShare((value) => Math.min(80, value + 3)); if (event.key === 'ArrowDown') setChartPaneShare((value) => Math.max(28, value - 3)); }} className="z-10 h-2 shrink-0 cursor-row-resize touch-none border-y border-slate-700 bg-slate-800 hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400" />
      </>}
      <section className={`flex min-h-0 flex-col gap-2 border-t border-slate-700 bg-slate-950/40 p-2 sm:p-3 ${visualPlayback ? 'min-h-[180px]' : 'flex-1'}`} style={{ flex: visualPlayback ? `${100 - chartPaneShare} 1 0%` : '1 1 0%' }}>
        <div className="flex shrink-0 flex-wrap gap-2" role="tablist" aria-label={visualPlayback ? 'Backtest result panes' : 'Fast backtest result panes'}><button role="tab" aria-selected={pane === 'trades'} onClick={() => setPane('trades')} className={`rounded px-3 py-1.5 text-[10px] ${pane === 'trades' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'}`}>Trades</button><button role="tab" aria-selected={pane === 'equity'} onClick={() => setPane('equity')} className={`rounded px-4 py-2 text-xs font-semibold ${pane === 'equity' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>Equity curve</button><button role="tab" aria-selected={pane === 'statistics'} onClick={() => setPane('statistics')} className={`rounded px-3 py-1.5 text-[10px] ${pane === 'statistics' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'}`}>Statistics</button></div>
        {!visualPlayback && result && <div className="shrink-0 rounded border border-emerald-800/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">Fast backtest complete · {bars.length.toLocaleString()} bars · {selectedSymbol} · {heikinAshi ? 'Heikin Ashi ' : ''}{selectedTimeframe} · {new Date(bars[0].time * 1000).toLocaleString()} – {new Date(bars.at(-1)!.time * 1000).toLocaleString()}</div>}
        <div className={`min-h-0 flex-1 flex-col overflow-hidden rounded border border-slate-700 bg-slate-900 ${pane === 'trades' ? 'flex' : 'hidden'}`}><header className="flex shrink-0 items-center justify-between border-b border-slate-700 px-3 py-2"><h2 className="text-xs font-semibold">Trades</h2><span className="text-[10px] text-slate-400">{result ? `${result.trades.length} trades · ${openTradesAtCursor} open at replay point` : 'No run yet'}</span></header><div className="min-h-0 flex-1 overflow-auto"><table className="w-full min-w-[780px] border-collapse text-left text-[10px]"><thead className="sticky top-0 bg-slate-950 text-slate-400"><tr>{['#', 'Side', 'Order', 'Status', 'Entry time', 'Entry', 'Exit time', 'Exit', 'Qty', 'P&L'].map((heading) => <th key={heading} className="border-b border-slate-700 px-2 py-2 font-medium">{heading}</th>)}</tr></thead><tbody>{pane === 'trades' && result?.trades.map((trade, index) => { const replay = tradeAtCursor(trade, bars, cursor); const exitReached = Boolean(trade.exit && trade.exit.time <= Math.round((bars[cursor]?.time ?? 0) * 1000)); const stateClass = replay.state === 'Closed' ? 'text-slate-300' : replay.state === 'Open' ? 'text-sky-300' : 'text-amber-300'; return <tr key={`${trade.id}-${index}`} className="border-b border-slate-800 hover:bg-slate-800/60"><td className="px-2 py-1.5 text-slate-500">{index + 1}</td><td className={`px-2 py-1.5 font-semibold uppercase ${trade.side === 'long' ? 'text-emerald-300' : 'text-rose-300'}`}>{trade.side}</td><td className="max-w-40 truncate px-2 py-1.5" title={trade.entry.comment || trade.entry.id || trade.id}>{trade.entry.comment || trade.entry.id || trade.id}</td><td className={`px-2 py-1.5 font-semibold ${stateClass}`}>{replay.state}</td><td className="whitespace-nowrap px-2 py-1.5">{new Date(trade.entry.time).toLocaleString()}</td><td className="px-2 py-1.5 font-mono">{trade.entry.price}</td><td className="whitespace-nowrap px-2 py-1.5">{exitReached ? new Date(trade.exit!.time).toLocaleString() : '—'}</td><td className="px-2 py-1.5 font-mono">{exitReached ? trade.exit!.price : '—'}</td><td className="px-2 py-1.5 font-mono">{trade.qty}</td><td className={`px-2 py-1.5 font-mono ${(replay.pnl ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{replay.pnl == null ? '—' : `${replay.state === 'Open' ? '≈ ' : ''}${money(replay.pnl)}`}</td></tr>; })}</tbody></table>{result && result.trades.length === 0 && <p className="p-6 text-center text-xs text-slate-500">No strategy orders filled in this date range.</p>}{result && result.trades.length > 0 && cursor < 0 && <p className="border-t border-slate-800 px-3 py-2 text-[10px] text-slate-400">All strategy fills are listed. Replay playback reveals each fill on the chart as its candle is reached.</p>}</div></div>
        <div className={`min-h-0 flex-1 flex-col overflow-hidden rounded border border-slate-700 bg-slate-900 ${pane === 'statistics' ? 'flex' : 'hidden'}`}><header className="flex shrink-0 items-center justify-between border-b border-slate-700 px-3 py-2"><h2 className="text-xs font-semibold">Statistics</h2><span className="text-[10px] text-slate-400">{strategy ? 'Strategy broker-emulator results' : result ? 'Indicator execution' : 'Awaiting run'}</span></header><div className="min-h-0 flex-1 overflow-auto p-2"><div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">{[
          ['Net profit', strategy ? money(strategy.netPnl) : '—', (strategy?.netPnl ?? 0) >= 0], ['Return', strategy ? pct(strategy.initialCapital ? strategy.netPnl / strategy.initialCapital * 100 : 0) : '—', (strategy?.netPnl ?? 0) >= 0], ['Max drawdown', strategy ? `${money(strategy.maxDrawdown)} (${strategy.initialCapital ? (strategy.maxDrawdown / strategy.initialCapital * 100).toFixed(2) : '0.00'}%)` : '—', false], ['Closed trades', String(closedTrades.length), true], ['Win rate', `${closedTrades.length ? (closedTrades.filter((trade) => (trade.pnl ?? 0) > 0).length / closedTrades.length * 100).toFixed(1) : '0.0'}%`, true], ['Profit factor', strategy ? (strategy.grossLoss ? (strategy.grossProfit / strategy.grossLoss).toFixed(2) : strategy.grossProfit ? '∞' : '—') : '—', true], ['Equity', strategy ? money(strategy.equity) : '—', (strategy?.equity ?? 0) >= (strategy?.initialCapital ?? 0)], ['Gross profit', strategy ? money(strategy.grossProfit) : '—', true], ['Gross loss', strategy ? money(-strategy.grossLoss) : '—', false], ['Open trades', String(openTradesAtCursor), true],
        ].map(([label, value, positive]) => <div key={String(label)} className="rounded border border-slate-700/80 bg-slate-950/60 px-2 py-1.5"><div className="truncate text-[9px] uppercase text-slate-500">{label}</div><div className={`truncate font-mono text-[11px] font-semibold ${positive ? 'text-emerald-300' : 'text-rose-300'}`}>{value}</div></div>)}</div>{result?.warnings.length ? <details className="mt-2 rounded border border-amber-800/60 p-2 text-[10px] text-amber-200"><summary className="cursor-pointer">Engine warnings ({result.warnings.length})</summary><ul className="list-disc pl-4">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}<p className="mt-2 text-[9px] text-slate-500">The chart shows final run metrics; trade status and open P&amp;L follow the replay cursor. Every Pine strategy fill is simulated locally. No broker orders are sent.</p></div></div>
        <div className={`min-h-0 flex-1 flex-col overflow-hidden rounded border border-slate-700 bg-slate-900 ${pane === 'equity' ? 'flex' : 'hidden'}`}><header className="flex shrink-0 items-center justify-between border-b border-slate-700 px-3 py-2"><h2 className="text-sm font-semibold">Equity curve</h2><span className="text-xs text-slate-400">Realized + open-position value per bar</span></header><EquityCurve result={result}/></div>
      </section>
      </div>
    </section>
  </div>;
};
