export interface PineSample {
  id: string;
  name: string;
  description: string;
  type: 'indicator' | 'strategy';
  code: string;
}

export const PINE_SAMPLES: PineSample[] = [
  {
    id: 'ema-cross-strategy',
    name: 'EMA Crossover Strategy',
    description: 'Trend-following strategy entering long on fast/slow EMA golden crosses and short on death crosses with backtest simulation.',
    type: 'strategy',
    code: `//@version=6
strategy("EMA Crossover Strategy", overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 10)

// Inputs
fastLength = input.int(9, title = "Fast EMA Length", minval = 1)
slowLength = input.int(21, title = "Slow EMA Length", minval = 1)

// Calculations
fastEMA = ta.ema(close, fastLength)
slowEMA = ta.ema(close, slowLength)

// Plot Overlays
plot(fastEMA, title = "Fast EMA", color = color.blue, linewidth = 2)
plot(slowEMA, title = "Slow EMA", color = color.orange, linewidth = 2)

// Trade Conditions
longCondition = ta.crossover(fastEMA, slowEMA)
shortCondition = ta.crossunder(fastEMA, slowEMA)

if (longCondition)
    strategy.entry("Long", strategy.long)

if (shortCondition)
    strategy.entry("Short", strategy.short)
`,
  },
  {
    id: 'bollinger-bands',
    name: 'Bollinger Bands & Mean Reversion',
    description: 'Standard 20-period 2.0-deviation volatility bands with dynamic basis trendline.',
    type: 'indicator',
    code: `//@version=6
indicator("Bollinger Bands Pro", overlay = true)

length = input.int(20, title = "Length", minval = 1)
mult = input.float(2.0, title = "StdDev Multiplier", minval = 0.1, step = 0.1)

[basis, upper, lower] = ta.bb(close, length, mult)

plot(upper, title = "BB Upper", color = color.gray, linewidth = 1)
plot(basis, title = "BB Basis", color = color.orange, linewidth = 2)
plot(lower, title = "BB Lower", color = color.gray, linewidth = 1)
`,
  },
  {
    id: 'rsi-oscillator',
    name: 'RSI Oscillator (14)',
    description: 'Classic Relative Strength Index oscillator with overbought (70) and oversold (30) levels in sub-pane.',
    type: 'indicator',
    code: `//@version=6
indicator("Relative Strength Index", overlay = false)

rsiLength = input.int(14, title = "RSI Length", minval = 1)
rsiSource = close

rsiValue = ta.rsi(rsiSource, rsiLength)

plot(rsiValue, title = "RSI", color = color.purple, linewidth = 2)
hline(70, title = "Overbought", color = color.red, linestyle = hline.style_dashed)
hline(30, title = "Oversold", color = color.green, linestyle = hline.style_dashed)
hline(50, title = "Middle Line", color = color.gray, linestyle = hline.style_dotted)
`,
  },
  {
    id: 'supertrend',
    name: 'Supertrend Trend Rider',
    description: 'ATR-based trend-following indicator showing dynamic trailing stop levels and direction flips.',
    type: 'indicator',
    code: `//@version=6
indicator("Supertrend Pro", overlay = true)

factor = input.float(3.0, title = "ATR Multiplier", minval = 0.5, step = 0.5)
atrPeriod = input.int(10, title = "ATR Period", minval = 1)

[superTrend, direction] = ta.supertrend(factor, atrPeriod)

plot(superTrend, title = "Supertrend", color = color.teal, linewidth = 2)
`,
  },
  {
    id: 'macd-oscillator',
    name: 'MACD Divergence Suite',
    description: 'Moving Average Convergence Divergence with fast line, signal line, and color-coded momentum histogram.',
    type: 'indicator',
    code: `//@version=6
indicator("MACD Pro", overlay = false)

fast_length = input.int(12, title = "Fast Length")
slow_length = input.int(26, title = "Slow Length")
signal_length = input.int(9, title = "Signal Length")

[macdLine, signalLine, histLine] = ta.macd(close, fast_length, slow_length, signal_length)

plot(macdLine, title = "MACD", color = color.blue, linewidth = 2)
plot(signalLine, title = "Signal", color = color.orange, linewidth = 2)
plot(histLine, title = "Histogram", color = color.green, style = plot.style_histogram, linewidth = 2)
`,
  },
  {
    id: 'cci-oscillator',
    name: 'CCI (20)',
    description: 'Commodity Channel Index with classic +100/−100 reference levels.',
    type: 'indicator',
    code: `//@version=6
indicator("CCI", overlay = false)

length = input.int(20, title = "Length", minval = 1)
source = input.source(hlc3, title = "Source")
cciValue = ta.cci(source, length)

plot(cciValue, title = "CCI", color = color.blue, linewidth = 2)
hline(100, title = "Overbought", color = color.red, linestyle = hline.style_dashed)
hline(0, title = "Zero", color = color.gray, linestyle = hline.style_dotted)
hline(-100, title = "Oversold", color = color.green, linestyle = hline.style_dashed)
`,
  },
  {
    id: 'stochastic-oscillator',
    name: 'Stochastic (14, 3, 3)',
    description: 'Classic stochastic %K/%D oscillator with 80/20 reference levels.',
    type: 'indicator',
    code: `//@version=6
indicator("Stochastic", overlay = false)

kLength = input.int(14, title = "%K Length", minval = 1)
kSmoothing = input.int(3, title = "%K Smoothing", minval = 1)
dLength = input.int(3, title = "%D Length", minval = 1)
rawK = ta.stoch(close, high, low, kLength)
smoothK = ta.sma(rawK, kSmoothing)
smoothD = ta.sma(smoothK, dLength)

plot(smoothK, title = "%K", color = color.blue, linewidth = 2)
plot(smoothD, title = "%D", color = color.orange, linewidth = 2)
hline(80, title = "Overbought", color = color.red, linestyle = hline.style_dashed)
hline(20, title = "Oversold", color = color.green, linestyle = hline.style_dashed)
`,
  },
  {
    id: 'williams-r-oscillator',
    name: 'Williams %R (14)',
    description: 'Williams Percent Range with −20/−80 reference levels.',
    type: 'indicator',
    code: `//@version=6
indicator("Williams %R", overlay = false)

length = input.int(14, title = "Length", minval = 1)
wprValue = ta.wpr(length)

plot(wprValue, title = "Williams %R", color = color.purple, linewidth = 2)
hline(-20, title = "Overbought", color = color.red, linestyle = hline.style_dashed)
hline(-80, title = "Oversold", color = color.green, linestyle = hline.style_dashed)
`,
  },
];
