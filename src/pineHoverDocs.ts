import { pineReference } from './pineReference.ts';

export interface PineDocParameter {
  name: string;
  type: string;
  optional: boolean;
  default?: string;
  description: string;
}

export interface PineDocItem {
  name: string;
  kind: 'function' | 'variable' | 'keyword' | 'constant';
  syntax: string;
  returns?: string;
  summary: string;
  parameters?: PineDocParameter[];
  example?: string;
  manual?: string;
}

export const PINE_DOCS: Record<string, PineDocItem> = {
  // Built-in Functions & Methods
  plot: {
    name: 'plot',
    kind: 'function',
    syntax: 'plot(series, title, color, linewidth, style, trackprice, histbase, offset, join, editable, show_last, display)',
    returns: 'plot object',
    summary: 'Plots a data series onto the chart canvas. If overlay=true in the indicator declaration, it renders directly on the candlestick stage; otherwise it renders in an oscillator sub-pane.',
    parameters: [
      { name: 'series', type: 'series int/float', optional: false, description: 'Data series to plot (e.g. close, ta.sma(close, 14), rsi).' },
      { name: 'title', type: 'const string', optional: true, default: '""', description: 'Title of the plot shown in the indicator legend and settings.' },
      { name: 'color', type: 'series color', optional: true, default: 'color.blue', description: 'Color of the plotted line, histogram bars, or symbols.' },
      { name: 'linewidth', type: 'input int', optional: true, default: '1', description: 'Width of the plotted line in pixels (1 to 4).' },
      { name: 'style', type: 'input plot_style', optional: true, default: 'plot.style_line', description: 'Visual style: plot.style_line, plot.style_histogram, plot.style_circles, plot.style_cross, plot.style_stepline.' },
      { name: 'trackprice', type: 'input bool', optional: true, default: 'false', description: 'If true, draws a horizontal line across the chart at the level of the last plotted value.' },
      { name: 'histbase', type: 'input float', optional: true, default: '0.0', description: 'Baseline price level for histogram plots.' },
      { name: 'offset', type: 'input int', optional: true, default: '0', description: 'Shifts the plotted series left (negative) or right (positive) by N bars.' },
      { name: 'show_last', type: 'input int', optional: true, default: 'all', description: 'Number of recent bars to display on the chart.' },
    ],
    example: 'plot(ta.ema(close, 20), title = "EMA 20", color = color.blue, linewidth = 2)',
  },

  indicator: {
    name: 'indicator',
    kind: 'function',
    syntax: 'indicator(title, shorttitle, overlay, format, precision, scale, max_bars_back)',
    returns: 'void',
    summary: 'Declares script properties for an indicator study. Must appear before any calculation logic.',
    parameters: [
      { name: 'title', type: 'const string', optional: false, description: 'Full title of the indicator script.' },
      { name: 'shorttitle', type: 'const string', optional: true, default: 'title', description: 'Short abbreviation displayed in the top bar and chart legend.' },
      { name: 'overlay', type: 'const bool', optional: true, default: 'false', description: 'If true, renders on top of candles; if false, creates a separate sub-pane below.' },
      { name: 'format', type: 'const string', optional: true, default: 'format.inherit', description: 'Number formatting: format.inherit, format.price, format.volume, format.percent.' },
      { name: 'precision', type: 'const int', optional: true, default: 'inherit', description: 'Number of decimal digits to display in price scale and legend.' },
      { name: 'max_bars_back', type: 'const int', optional: true, default: '500', description: 'Maximum historical buffer size for series index lookups.' },
    ],
    example: 'indicator("Relative Strength Index", shorttitle="RSI", overlay=false, precision=2)',
  },

  strategy: {
    name: 'strategy',
    kind: 'function',
    syntax: 'strategy(title, shorttitle, overlay, initial_capital, default_qty_type, default_qty_value, slippage, commission_value)',
    returns: 'void',
    summary: 'Declares a backtesting strategy script capable of simulating order placement, execution fills, win rate, profit factor, and equity curves.',
    parameters: [
      { name: 'title', type: 'const string', optional: false, description: 'Title of the strategy.' },
      { name: 'shorttitle', type: 'const string', optional: true, default: 'title', description: 'Short strategy identifier.' },
      { name: 'overlay', type: 'const bool', optional: true, default: 'true', description: 'Whether to render strategy signals directly on the main candlestick chart.' },
      { name: 'initial_capital', type: 'const int/float', optional: true, default: '10000', description: 'Starting portfolio balance in account currency.' },
      { name: 'default_qty_type', type: 'const string', optional: true, default: 'strategy.percent_of_equity', description: 'Position sizing rule: strategy.percent_of_equity, strategy.fixed, strategy.cash.' },
      { name: 'default_qty_value', type: 'const float', optional: true, default: '10', description: 'Amount or percentage risked per trade.' },
      { name: 'slippage', type: 'const int', optional: true, default: '0', description: 'Order slippage in ticks/points.' },
      { name: 'commission_value', type: 'const float', optional: true, default: '0.0', description: 'Commission charged per trade or per order volume.' },
    ],
    example: 'strategy("Dual EMA Crossover", overlay=true, initial_capital=10000, default_qty_value=10)',
  },

  'ta.sma': {
    name: 'ta.sma',
    kind: 'function',
    syntax: 'ta.sma(source, length) -> series float',
    returns: 'series float: Simple moving average of source over length bars',
    summary: 'Calculates the arithmetic Simple Moving Average (SMA) of a series by summing the last N bars and dividing by N.',
    parameters: [
      { name: 'source', type: 'series int/float', optional: false, description: 'The price series to calculate the average on (e.g. close, high, hl2, hlc3).' },
      { name: 'length', type: 'simple int', optional: false, description: 'The lookback window size in bars (must be greater than 0).' },
    ],
    example: 'sma50 = ta.sma(close, 50)\nplot(sma50, color = color.orange, linewidth = 2)',
  },

  'ta.ema': {
    name: 'ta.ema',
    kind: 'function',
    syntax: 'ta.ema(source, length) -> series float',
    returns: 'series float: Exponentially weighted moving average of source',
    summary: 'Calculates the Exponential Moving Average (EMA). Applies exponentially decreasing weighting multiplier alpha = 2 / (length + 1) to historical bars, reacting faster to recent price action.',
    parameters: [
      { name: 'source', type: 'series int/float', optional: false, description: 'The input series (typically close, hlc3, or volume).' },
      { name: 'length', type: 'simple int', optional: false, description: 'Lookback length in bars.' },
    ],
    example: 'ema20 = ta.ema(close, 20)\nplot(ema20, color = color.blue, linewidth = 2)',
  },

  'ta.rsi': {
    name: 'ta.rsi',
    kind: 'function',
    syntax: 'ta.rsi(source, length) -> series float',
    returns: 'series float: Relative Strength Index bounded between 0.0 and 100.0',
    summary: 'Calculates the classic J. Welles Wilder Relative Strength Index oscillator measuring the speed and change of price movements.',
    parameters: [
      { name: 'source', type: 'series int/float', optional: false, description: 'Series to evaluate, usually close.' },
      { name: 'length', type: 'simple int', optional: false, description: 'Period length in bars, typically 14.' },
    ],
    example: 'rsiVal = ta.rsi(close, 14)\nplot(rsiVal, title = "RSI", color = color.purple)\nhline(70, "Overbought", color.red)\nhline(30, "Oversold", color.green)',
  },

  'ta.macd': {
    name: 'ta.macd',
    kind: 'function',
    syntax: 'ta.macd(source, fastlen, slowlen, siglen) -> [series float, series float, series float]',
    returns: '[macdLine, signalLine, histLine]',
    summary: 'Calculates Moving Average Convergence Divergence trend oscillator, returning a tuple of MACD line, Signal line, and Histogram delta.',
    parameters: [
      { name: 'source', type: 'series int/float', optional: false, description: 'Input price series (typically close).' },
      { name: 'fastlen', type: 'simple int', optional: false, description: 'Fast EMA length (standard is 12).' },
      { name: 'slowlen', type: 'simple int', optional: false, description: 'Slow EMA length (standard is 26).' },
      { name: 'siglen', type: 'simple int', optional: false, description: 'Signal smoothing length (standard is 9).' },
    ],
    example: '[macd, signal, hist] = ta.macd(close, 12, 26, 9)\nplot(macd, color=color.blue)\nplot(signal, color=color.orange)\nplot(hist, style=plot.style_histogram, color=color.gray)',
  },

  'ta.bb': {
    name: 'ta.bb',
    kind: 'function',
    syntax: 'ta.bb(series, length, mult) -> [series float, series float, series float]',
    returns: '[middleBasis, upperBand, lowerBand]',
    summary: 'Calculates John Bollinger Bands volatility envelopes based on SMA and standard deviations.',
    parameters: [
      { name: 'series', type: 'series int/float', optional: false, description: 'Input series (usually close).' },
      { name: 'length', type: 'simple int', optional: false, description: 'Number of bars for moving average basis (typically 20).' },
      { name: 'mult', type: 'simple float', optional: false, description: 'Standard deviation multiplier (typically 2.0).' },
    ],
    example: '[basis, upper, lower] = ta.bb(close, 20, 2.0)\nplot(basis, color=color.orange)\nplot(upper, color=color.teal)\nplot(lower, color=color.teal)',
  },

  'ta.atr': {
    name: 'ta.atr',
    kind: 'function',
    syntax: 'ta.atr(length) -> series float',
    returns: 'series float: Average True Range in price units',
    summary: 'Measures market volatility by taking an RMA of True Range (max of high-low, abs(high-close[1]), abs(low-close[1])).',
    parameters: [
      { name: 'length', type: 'simple int', optional: false, description: 'Lookback window in bars (standard is 14).' },
    ],
    example: 'atr = ta.atr(14)\nstopDistance = atr * 1.5',
  },

  'ta.supertrend': {
    name: 'ta.supertrend',
    kind: 'function',
    syntax: 'ta.supertrend(factor, atrPeriod) -> [series float, series int]',
    returns: '[superTrendPrice, direction (1 for up, -1 for down)]',
    summary: 'Calculates the SuperTrend trailing stop indicator based on ATR volatility bands.',
    parameters: [
      { name: 'factor', type: 'simple float', optional: false, description: 'ATR multiplier multiplier (e.g. 3.0).' },
      { name: 'atrPeriod', type: 'simple int', optional: false, description: 'ATR period length (e.g. 10).' },
    ],
    example: '[stPrice, stDir] = ta.supertrend(3.0, 10)\nplot(stPrice, color = stDir == 1 ? color.green : color.red)',
  },

  'ta.crossover': {
    name: 'ta.crossover',
    kind: 'function',
    syntax: 'ta.crossover(source1, source2) -> series bool',
    returns: 'series bool: true on the bar where source1 crosses above source2',
    summary: 'Detects upward crossover event: true if source1[1] <= source2[1] and source1 > source2.',
    parameters: [
      { name: 'source1', type: 'series int/float', optional: false, description: 'Fast moving series.' },
      { name: 'source2', type: 'series int/float', optional: false, description: 'Slow benchmark series or threshold level.' },
    ],
    example: 'longCondition = ta.crossover(ta.ema(close, 9), ta.ema(close, 21))',
  },

  'ta.crossunder': {
    name: 'ta.crossunder',
    kind: 'function',
    syntax: 'ta.crossunder(source1, source2) -> series bool',
    returns: 'series bool: true on the bar where source1 crosses below source2',
    summary: 'Detects downward crossunder event: true if source1[1] >= source2[1] and source1 < source2.',
    parameters: [
      { name: 'source1', type: 'series int/float', optional: false, description: 'Fast moving series.' },
      { name: 'source2', type: 'series int/float', optional: false, description: 'Slow benchmark series or threshold level.' },
    ],
    example: 'shortCondition = ta.crossunder(ta.ema(close, 9), ta.ema(close, 21))',
  },

  'strategy.entry': {
    name: 'strategy.entry',
    kind: 'function',
    syntax: 'strategy.entry(id, direction, qty, limit, stop, comment)',
    returns: 'void',
    summary: 'Submits or queues an order entry for simulation. If an opposing position is open, automatically reverses or covers it.',
    parameters: [
      { name: 'id', type: 'const string', optional: false, description: 'Unique order identifier string (e.g. "Buy", "Sell").' },
      { name: 'direction', type: 'strategy_direction', optional: false, description: 'strategy.long or strategy.short.' },
      { name: 'qty', type: 'series int/float', optional: true, description: 'Number of contracts or shares to trade. Overrides default_qty.' },
      { name: 'limit', type: 'series float', optional: true, description: 'Limit price for pending order.' },
      { name: 'stop', type: 'series float', optional: true, description: 'Stop price for breakout order.' },
      { name: 'comment', type: 'series string', optional: true, description: 'Execution tag or logging message.' },
    ],
    example: 'if ta.crossover(ta.ema(close, 10), ta.ema(close, 30))\n    strategy.entry("Long", strategy.long)',
  },

  'strategy.close': {
    name: 'strategy.close',
    kind: 'function',
    syntax: 'strategy.close(id, comment, qty, qty_percent)',
    returns: 'void',
    summary: 'Closes a specific open position identified by its entry ID.',
    parameters: [
      { name: 'id', type: 'const string', optional: false, description: 'The entry ID to close.' },
      { name: 'comment', type: 'series string', optional: true, description: 'Reason for closing order.' },
      { name: 'qty', type: 'series float', optional: true, description: 'Partial close amount.' },
      { name: 'qty_percent', type: 'series float', optional: true, description: 'Percentage of position to close (1 to 100).' },
    ],
    example: 'strategy.close("Long", comment="Take Profit Reached")',
  },

  'strategy.close_all': {
    name: 'strategy.close_all',
    kind: 'function',
    syntax: 'strategy.close_all(comment)',
    returns: 'void',
    summary: 'Closes all open positions regardless of their entry ID.',
    parameters: [
      { name: 'comment', type: 'series string', optional: true, description: 'Closing comment string.' },
    ],
    example: 'strategy.close_all(comment = "End of Session")',
  },

  'color.new': {
    name: 'color.new',
    kind: 'function',
    syntax: 'color.new(baseColor, transp) -> color',
    returns: 'color with applied alpha transparency',
    summary: 'Applies transparency percentage (0 to 100) to an existing color.',
    parameters: [
      { name: 'baseColor', type: 'color', optional: false, description: 'Target base color (e.g. color.blue, color.green, #2962FF).' },
      { name: 'transp', type: 'simple int/float', optional: false, description: 'Transparency percentage: 0 = completely opaque, 100 = completely invisible.' },
    ],
    example: 'color.new(color.blue, 70) // 70% transparent blue',
  },

  'color.rgb': {
    name: 'color.rgb',
    kind: 'function',
    syntax: 'color.rgb(red, green, blue, transp) -> color',
    returns: 'color',
    summary: 'Creates a custom color from RGB channel components.',
    parameters: [
      { name: 'red', type: 'simple int', optional: false, description: 'Red component (0 to 255).' },
      { name: 'green', type: 'simple int', optional: false, description: 'Green component (0 to 255).' },
      { name: 'blue', type: 'simple int', optional: false, description: 'Blue component (0 to 255).' },
      { name: 'transp', type: 'simple int', optional: true, default: '0', description: 'Transparency percentage (0 to 100).' },
    ],
    example: 'customColor = color.rgb(41, 98, 255, 20)',
  },

  'input.int': {
    name: 'input.int',
    kind: 'function',
    syntax: 'input.int(defval, title, minval, maxval, step, group, tooltip)',
    returns: 'input int value configured by user',
    summary: 'Adds an integer input field in the indicator settings dialog.',
    parameters: [
      { name: 'defval', type: 'const int', optional: false, description: 'Default integer value.' },
      { name: 'title', type: 'const string', optional: true, description: 'Label displayed beside the input.' },
      { name: 'minval', type: 'const int', optional: true, description: 'Minimum allowed value.' },
      { name: 'maxval', type: 'const int', optional: true, description: 'Maximum allowed value.' },
      { name: 'step', type: 'const int', optional: true, default: '1', description: 'Increment/decrement step size.' },
      { name: 'group', type: 'const string', optional: true, description: 'Header group in settings tab.' },
      { name: 'tooltip', type: 'const string', optional: true, description: 'Help tooltip on hover.' },
    ],
    example: 'len = input.int(14, title="Length", minval=1)',
  },

  'input.float': {
    name: 'input.float',
    kind: 'function',
    syntax: 'input.float(defval, title, minval, maxval, step, group, tooltip)',
    returns: 'input float value',
    summary: 'Adds a floating-point input field in the indicator settings dialog.',
    parameters: [
      { name: 'defval', type: 'const float', optional: false, description: 'Default floating-point value.' },
      { name: 'title', type: 'const string', optional: true, description: 'Label title in settings.' },
      { name: 'minval', type: 'const float', optional: true, description: 'Minimum allowable value.' },
      { name: 'maxval', type: 'const float', optional: true, description: 'Maximum allowable value.' },
      { name: 'step', type: 'const float', optional: true, default: '0.1', description: 'Step size.' },
    ],
    example: 'mult = input.float(2.0, title="StdDev Multiplier", step=0.1)',
  },

  'input.bool': {
    name: 'input.bool',
    kind: 'function',
    syntax: 'input.bool(defval, title, group, tooltip)',
    returns: 'input bool value',
    summary: 'Adds a boolean checkbox in the indicator settings dialog.',
    parameters: [
      { name: 'defval', type: 'const bool', optional: false, description: 'Default checked state.' },
      { name: 'title', type: 'const string', optional: true, description: 'Checkbox label text.' },
    ],
    example: 'showEMA = input.bool(true, title="Show 200 EMA")',
  },

  'input.source': {
    name: 'input.source',
    kind: 'function',
    syntax: 'input.source(defval, title, group, tooltip)',
    returns: 'series float source selected by user',
    summary: 'Adds a price source dropdown (close, open, high, low, hl2, hlc3, ohlc4) in indicator settings.',
    parameters: [
      { name: 'defval', type: 'series float', optional: false, description: 'Default series (typically close).' },
      { name: 'title', type: 'const string', optional: true, description: 'Label title.' },
    ],
    example: 'src = input.source(close, title="Calculation Source")',
  },

  hline: {
    name: 'hline',
    kind: 'function',
    syntax: 'hline(price, title, color, linestyle, linewidth)',
    returns: 'hline object',
    summary: 'Renders a constant horizontal line at a fixed price level across all bars.',
    parameters: [
      { name: 'price', type: 'input int/float', optional: false, description: 'Price level for horizontal line.' },
      { name: 'title', type: 'const string', optional: true, description: 'Title label.' },
      { name: 'color', type: 'color', optional: true, default: 'color.gray', description: 'Line color.' },
      { name: 'linestyle', type: 'input hline_style', optional: true, default: 'hline.style_solid', description: 'hline.style_solid, hline.style_dashed, hline.style_dotted.' },
      { name: 'linewidth', type: 'input int', optional: true, default: '1', description: 'Thickness in pixels (1 to 4).' },
    ],
    example: 'hline(50, title="Equilibrium", color=color.gray, linestyle=hline.style_dashed)',
  },

  fill: {
    name: 'fill',
    kind: 'function',
    syntax: 'fill(plot1, plot2, color, title, editable, show_last)',
    returns: 'void',
    summary: 'Fills the space between two plot objects or hlines with a solid or translucent color.',
    parameters: [
      { name: 'plot1', type: 'plot/hline', optional: false, description: 'First plot boundary object.' },
      { name: 'plot2', type: 'plot/hline', optional: false, description: 'Second plot boundary object.' },
      { name: 'color', type: 'series color', optional: false, description: 'Color of the filled area (typically with transparency).' },
      { name: 'title', type: 'const string', optional: true, description: 'Title in settings.' },
    ],
    example: 'p1 = plot(upper)\np2 = plot(lower)\nfill(p1, p2, color=color.new(color.blue, 90))',
  },

  // Built-in Variables
  close: {
    name: 'close',
    kind: 'variable',
    syntax: 'close -> series float',
    returns: 'series float',
    summary: 'Current or historical close price of the candlestick bar. Historical bars can be accessed using indexing brackets: close[1] is the previous bar close.',
    example: 'isBullish = close > open\nprevClose = close[1]',
  },

  open: {
    name: 'open',
    kind: 'variable',
    syntax: 'open -> series float',
    returns: 'series float',
    summary: 'Opening price of the current or historical candlestick bar.',
    example: 'bodySize = math.abs(close - open)',
  },

  high: {
    name: 'high',
    kind: 'variable',
    syntax: 'high -> series float',
    returns: 'series float',
    summary: 'Highest price reached during the candlestick bar period.',
    example: 'upperWick = high - math.max(open, close)',
  },

  low: {
    name: 'low',
    kind: 'variable',
    syntax: 'low -> series float',
    returns: 'series float',
    summary: 'Lowest price reached during the candlestick bar period.',
    example: 'lowerWick = math.min(open, close) - low',
  },

  volume: {
    name: 'volume',
    kind: 'variable',
    syntax: 'volume -> series float',
    returns: 'series float',
    summary: 'Total traded volume of contracts, lots, or shares for the current bar.',
    example: 'highVolume = volume > ta.sma(volume, 20) * 1.5',
  },

  time: {
    name: 'time',
    kind: 'variable',
    syntax: 'time -> series int',
    returns: 'series int (UNIX timestamp in milliseconds)',
    summary: 'Opening UNIX timestamp in milliseconds (UTC) of the current bar.',
    example: 'barTime = time',
  },

  bar_index: {
    name: 'bar_index',
    kind: 'variable',
    syntax: 'bar_index -> series int',
    returns: 'series int',
    summary: 'Zero-based sequential index of the current bar, incrementing from 0 on the earliest loaded bar.',
    example: 'isFirst100Bars = bar_index < 100',
  },

  hl2: {
    name: 'hl2',
    kind: 'variable',
    syntax: 'hl2 -> series float',
    returns: 'series float: (high + low) / 2',
    summary: 'Median price of the bar, equal to the average of High and Low.',
    example: 'medianEMA = ta.ema(hl2, 20)',
  },

  hlc3: {
    name: 'hlc3',
    kind: 'variable',
    syntax: 'hlc3 -> series float',
    returns: 'series float: (high + low + close) / 3',
    summary: 'Typical price of the bar, equal to (High + Low + Close) / 3.',
    example: 'typicalEMA = ta.ema(hlc3, 14)',
  },

  ohlc4: {
    name: 'ohlc4',
    kind: 'variable',
    syntax: 'ohlc4 -> series float',
    returns: 'series float: (open + high + low + close) / 4',
    summary: 'Average price of the bar, equal to (Open + High + Low + Close) / 4.',
    example: 'avgPrice = ohlc4',
  },

  // Keywords
  var: {
    name: 'var',
    kind: 'keyword',
    syntax: 'var type name = initial_value',
    summary: 'Declares a persistent state variable that retains its value across historical bars without re-initializing on every new bar.',
    example: 'var int winCount = 0\nif strategy.netprofit > strategy.netprofit[1]\n    winCount := winCount + 1',
  },

  if: {
    name: 'if',
    kind: 'keyword',
    syntax: 'if condition\n    expression\nelse\n    expression',
    summary: 'Conditional branch statement. Evaluates condition expression and executes the indented block if true.',
    example: 'trendColor = if close > ta.ema(close, 50)\n    color.green\nelse\n    color.red',
  },

  for: {
    name: 'for',
    kind: 'keyword',
    syntax: 'for i = from to to [by step]\n    statements',
    summary: 'Counting loop structure iterating an index variable from a starting value to an ending value.',
    example: 'var float sum = 0.0\nfor i = 0 to 9\n    sum := sum + close[i]',
  },
};

// Fill missing keyword and built-in coverage from the reference used by OMEGA.
// Keep Vela's richer parameter docs when an entry already exists.
for (const entry of pineReference) {
  if (PINE_DOCS[entry.name]) continue;
  const codeExample = entry.manual?.match(/```(?:pine|pinescript)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const lowerName = entry.name.toLowerCase();
  const kind: PineDocItem['kind'] = entry.signature.includes('(')
    ? 'function'
    : ['if', 'else', 'for', 'while', 'switch', 'break', 'continue', 'return', 'var', 'varip', 'import', 'export', 'type', 'method'].includes(lowerName)
      ? 'keyword'
      : 'variable';
  PINE_DOCS[entry.name] = {
    name: entry.name,
    kind,
    syntax: entry.signature,
    summary: entry.description,
    ...(codeExample ? { example: codeExample } : {}),
    ...(entry.manual ? { manual: entry.manual } : {}),
  };
}

/**
 * Resolves hover documentation for a word or dotted expression in Monaco
 */
export function getPineHoverDoc(symbol: string): PineDocItem | null {
  const clean = symbol.trim();
  if (PINE_DOCS[clean]) {
    return PINE_DOCS[clean];
  }
  // Try matching without namespace or alias
  const lower = clean.toLowerCase();
  for (const key of Object.keys(PINE_DOCS)) {
    if (key.toLowerCase() === lower) {
      return PINE_DOCS[key];
    }
  }
  return null;
}
