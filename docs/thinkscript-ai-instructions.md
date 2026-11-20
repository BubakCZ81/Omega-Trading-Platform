# Omega ThinkScript-inspired language: AI instructions

## Mission and hard limits

Create **ThinkScript-inspired Omega studies**, not general ThinkScript and not a
claim of thinkorswim compatibility. Translate only constructs that the current
Omega ThinkScript compiler explicitly accepts and that the installed PineTS
runtime can execute. Keep conversion parser-based; never evaluate user source as
JavaScript or execute generated source outside PineTS.

The initial compiler is indicator-only. It supports a deliberately small,
same-timeframe subset and rejects everything else with a source location and a
plain explanation. Never silently omit a declaration, function, plot, or
behavior, and never replace an unsupported operation with an approximate one.

## Language subset currently implemented

| ThinkScript construct | Omega/PineTS mapping |
| --- | --- |
| No `declare`, or `declare upper;` | `indicator(..., overlay=true)` |
| `declare lower;` | `indicator(..., overlay=false)` |
| Numeric `input name = literal;` | `input.int(...)` for integer defaults, otherwise `input.float(...)` |
| Boolean `input name = true/false;` | `input.bool(...)` |
| Price-source `input name = open/high/low/close/volume;` | `input.source(...)` |
| `def name = expression;` | Pine series assignment |
| `plot Name = expression;` | `plot(expression, "Name")` |
| `open`, `high`, `low`, `close`, `volume` | Same Pine series |
| `Average(x, n)` | `ta.sma(x, n)` |
| `ExpAverage(x, n)` | `ta.ema(x, n)` |
| `Highest(x, n)` / `Lowest(x, n)` | `ta.highest(x, n)` / `ta.lowest(x, n)` |
| `Sum(x, n)` | `ta.sum(x, n)` |
| Arithmetic, comparisons, `and`/`or`/`not`, parentheses | Equivalent Pine expressions |
| `if condition then yes else no` | Pine conditional expression |
| `series[n]` | Pine historical series indexing |

Declarations and references must be well-formed and ordered. Inputs accept only
literal numeric/boolean defaults or one of the five price series as a source.
Named input options, enums, strings, recursive definitions, forward
references, user scripts/functions, dynamic coloring, drawings, alerts,
fundamental data, and strategy statements are not implemented.

## Multi-timeframe (MTF) policy

ThinkScript's secondary aggregation syntax includes expressions such as
`close(period = AggregationPeriod.DAY)`. PineTS exposes
`request.security(symbol, timeframe, expression)`, and the installed Vela
PineTS adapter documents host-fetched secondary contexts. That API availability
does **not** by itself prove equivalent bar construction, alignment, gap, or
lookahead behavior for every Omega feed.

The current compiler therefore **rejects all period/named-argument price
references and does not emit `request.security`**. Do not describe the initial
prototype as MTF-capable. Enable MTF only after a separate test verifies the
requested aggregation against fixed primary and secondary OHLCV series supplied
through Omega's actual chart-data path. Any future mapping must be restricted to
constant time aggregations supported by both systems, reject lower-than-chart
periods, and explicitly define alignment and missing-bar behavior. Tick, range,
option-expiration, symbol-expression, and other data-source semantics remain
unsupported unless separately implemented and verified.

## Output and safety rules

1. Emit Pine Script v6 with one `indicator()` declaration; never emit
   `strategy()` or `strategy.*` calls.
2. Keep inputs and plot names stable. Do not synthesize orders, alerts, broker
   actions, provider calls, or account operations.
3. If syntax or a function is outside the subset, return a diagnostic containing
   its line and column. Do not return partially converted code as executable.
4. Test every new mapping with a golden ThinkScript-to-Pine example and execute
   that Pine output through the repository's installed PineTS version on fixed,
   local OHLCV bars. Do not use network market data for compiler tests.
5. Treat PineTS output as a calculated plot series only; do not infer
   thinkorswim parity from a successful PineTS run.

## Verified references and compatibility caveats

- [thinkScript reference](https://toslc.thinkorswim.com/center/reference/thinkScript)
  describes thinkScript studies, strategies, declarations, functions, constants,
  operators, and reserved words.
- [Declarations](https://toslc.thinkorswim.com/center/reference/thinkScript/Declarations),
  [upper](https://toslc.thinkorswim.com/center/reference/thinkScript/Declarations/upper),
  and [lower](https://toslc.thinkorswim.com/center/reference/thinkScript/Declarations/lower)
  document study placement. `upper` is the documented default when neither
  `lower` nor `on_volume` is declared.
- [input](https://toslc.thinkorswim.com/center/reference/thinkScript/Reserved-Words/input),
  [def](https://toslc.thinkorswim.com/center/reference/thinkScript/Reserved-Words/def),
  and [plot](https://toslc.thinkorswim.com/center/reference/thinkScript/Reserved-Words/plot)
  document declarations, adjustable inputs, series variables, and chart plots.
- [close](https://toslc.thinkorswim.com/center/reference/thinkScript/Functions/Fundamentals/close),
  [aggregation periods](https://toslc.thinkorswim.com/center/reference/thinkScript/Constants/AggregationPeriod),
  and [referencing secondary aggregation](https://toslc.thinkorswim.com/center/reference/thinkScript/tutorials/Advanced/Chapter-11---Referencing-Secondary-Aggregation)
  describe period-specific price series and ThinkScript's secondary-period
  restrictions and context propagation.
- [PineTS repository and API overview](https://github.com/LuxAlgo/PineTS) documents
  native Pine v6 execution, plot outputs, technical-analysis methods, inputs,
  and `request.security`. The project is tested against installed `pinets`
  **0.13.1** and `@luxalgo/vela-pinets` **0.3.3**; re-check the installed types
  and execution tests before relying on newer or unlisted methods.

## Licensing gate

This checkout's root `LICENSE.txt` is Apache-2.0, while the already-installed
`pinets` 0.13.1 and `@luxalgo/vela-pinets` 0.3.3 packages identify their license
as **AGPL-3.0-only**. The project already depends on both packages; this
prototype adds no package. Open-source status alone does not establish that the
combined app's distribution model and obligations are compatible. Obtain a
license/compliance review before publishing or distributing the integrated
application; do not change the app's license or present this note as legal
advice.

## Initial vertical slice

`src/thinkScriptCompiler.ts` implements the supported subset above.
`src/thinkScriptCompiler.test.mjs` checks a golden translation, rejection
diagnostics, and execution of the generated Pine through installed PineTS using
fixed OHLCV bars. The test is a compiler/runtime smoke test, not a
thinkorswim-parity or MTF test.
