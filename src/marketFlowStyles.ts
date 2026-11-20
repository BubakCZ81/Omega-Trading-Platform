/**
 * Stylesheet for the Time & Sales and DOM side panels.
 *
 * Kept out of marketFlowPane.ts so the panel's logic and its presentation can be read
 * separately. `installPanelStyles()` in the panel module injects this text once, exactly
 * as it did when the string was declared inline.
 */
export const panelStyles = `
  .omega-market-flow { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--omega-market-text,var(--vela-fg,#d1d4dc)); background:var(--omega-market-bg,var(--vela-bg,#131722)); font:var(--omega-market-font-size,0.75rem)/1.45 sans-serif; }
  .omega-market-flow-status { padding:0.5rem 0.625rem; color:var(--omega-market-text,var(--vela-muted,#9ca3af)); border-bottom:0.0625rem solid var(--omega-market-grid,var(--vela-border,#2a2e39)); font-size:.9em; }
  .omega-market-flow-status[data-state="live"] { color:var(--omega-success,#10b981); }
  .omega-market-flow-status[data-state="warning"] { color:var(--omega-warning,#f59e0b); }
  .omega-market-flow-status[data-state="error"] { color:var(--omega-error,#f23645); }
  .omega-market-flow-note { margin:0.5rem; padding:0.4375rem 0.5625rem; color:var(--omega-market-text,var(--vela-fg,#d1d4dc)); background:color-mix(in srgb,var(--omega-market-text,#d1d4dc) 7%,transparent); border:0.0625rem solid color-mix(in srgb,var(--omega-market-text,#d1d4dc) 22%,transparent); border-radius:0.25rem; font-size:.9em; }
  .omega-market-flow-table-wrap { flex:1; min-height:0; overflow:auto; }
  .omega-market-flow-table { width:100%; border-collapse:separate; border-spacing:0; font: .92em/1.4 Consolas,monospace; font-variant-numeric:tabular-nums; color:var(--omega-market-text,#d1d4dc); }
  .omega-market-flow-table th,.omega-market-flow-table td { padding:0.375rem 0.5rem; text-align:right; white-space:nowrap; }
  .omega-market-flow-table th { position:sticky; top:0; overflow:visible; color:var(--omega-market-text,var(--vela-muted,#9ca3af)); background:var(--omega-market-bg,var(--vela-bg,#131722)); border-bottom:0.0625rem solid var(--omega-market-grid,var(--vela-border,#2a2e39)); font-size:calc(var(--omega-market-font-size,0.75rem) * 1.0833); font-weight:700; }
  .omega-market-flow-table-resizable { table-layout:fixed; }
  .omega-market-flow-table-resizable .omega-market-flow-column-boundary { border-right:0.125rem solid var(--omega-separator,var(--vela-separator,var(--vela-border,#64748b))); }
  .omega-market-flow-table-resizable th.omega-market-flow-column-boundary { border-right:0.1875rem solid var(--omega-separator,var(--vela-separator,var(--vela-border,#64748b))); }
  /* The column resize handle is invisible until hovered. It used to paint a blue bar beside
     every separator, which read as a stray label rather than as a control. */
  .omega-market-flow-column-resizer { appearance:none; position:absolute; z-index:2; top:0; right:-0.3125rem; width:0.6875rem; height:100%; padding:0; border:0; background:transparent; cursor:col-resize; touch-action:none; opacity:0; transition:opacity .12s ease; }
  .omega-market-flow-column-resizer::after { content:""; position:absolute; top:12%; bottom:12%; left:0.3125rem; width:0.125rem; border-radius:0.125rem; background:var(--vela-accent,#4d9cff); }
  .omega-market-flow-column-resizer:hover,.omega-market-flow-column-resizer:focus-visible { opacity:1; }
  .omega-market-flow-table th:first-child,.omega-market-flow-table td:first-child { text-align:left; }
  .omega-market-flow-table .omega-market-flow-price { text-align:left; }
  .omega-market-flow-table tbody td { font-size:calc(var(--omega-market-font-size,0.75rem) * 1.1667); font-weight:700; }
  /* Omega v4: colours come from theme tokens, never from a hardcoded light or
     dark hex, so Time & Sales stays readable in dark, light,
     both supported themes alike. */
  .omega-market-flow-time,.omega-market-flow-size { color:var(--omega-market-text,var(--vela-fg,var(--omega-text,#d1d4dc))); letter-spacing:.01em; }
  .omega-market-flow-table tbody td.omega-market-flow-buy,
  .omega-market-flow-table .omega-market-flow-buy { color:var(--omega-market-buy,var(--omega-market-up-fallback,var(--omega-success,#22c55e))); }
  .omega-market-flow-table tbody td.omega-market-flow-sell,
  .omega-market-flow-table .omega-market-flow-sell { color:var(--omega-market-sell,var(--omega-market-down-fallback,var(--omega-error,#ef5350))); }
  .omega-market-flow-size { min-width:6ch; }
  .omega-market-flow-table tbody tr+tr { border-top:0.0625rem solid var(--omega-market-grid,var(--vela-border,#2a2e39)); }
  .omega-market-flow-buy { color:var(--omega-market-buy,var(--omega-market-up-fallback,var(--omega-success,#10b981))); }
  .omega-market-flow-sell { color:var(--omega-market-sell,var(--omega-market-down-fallback,var(--omega-error,#f23645))); }
  /* Keep the tape palette authoritative even when an older saved panel style
     or an older renderer bundle is still present. The direction colours match
     Quantower and apply to every cell in the trade row. */
  .omega-market-flow-table tbody tr:has(.omega-market-flow-buy) td { color:#00b8c8 !important; }
  .omega-market-flow-table tbody tr:has(.omega-market-flow-sell) td { color:#ff4b00 !important; }
  .omega-market-flow-empty { padding:1rem 0.625rem; color:var(--omega-market-text,var(--vela-muted,#9ca3af)); text-align:center; }
  .omega-market-flow-depth-cell { position:relative; isolation:isolate; overflow:hidden; }
  .omega-market-flow-depth-bar { position:absolute; z-index:0; inset-block:0.125rem; opacity:.48; pointer-events:none; }
  .omega-market-flow-depth-bar.bid { right:0; background:var(--omega-market-buy,var(--omega-market-up-fallback,var(--omega-success,#10b981))); }
  .omega-market-flow-depth-bar.ask { left:0; background:var(--omega-market-sell,var(--omega-market-down-fallback,var(--omega-error,#f23645))); }
  /* Depth values sit on top of the translucent bars: panel text colour plus a
     theme-aware halo keeps them readable on every theme and colour setting. */
  .omega-market-flow-depth-value { position:relative; z-index:1; color:var(--omega-market-text,var(--vela-fg,var(--omega-text,#d1d4dc))); font-size:calc(var(--omega-market-font-size,0.75rem) * 1.1667); font-weight:800; text-shadow:0 0.0625rem 0.125rem var(--omega-market-depth-shadow,rgb(0 0 0 / 55%)); }
  .omega-market-flow-mode { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; align-items:center; gap:0.5rem; margin:0.5rem; }
  .omega-market-flow-mode-label,.omega-market-flow-window-label { color:var(--omega-market-text,var(--vela-fg,#d1d4dc)); font-weight:700; }
  .omega-market-flow-mode-select,.omega-market-flow-window-size { min-width:0; padding:0.45rem 0.6rem; border:0.0625rem solid var(--omega-market-grid,var(--vela-border,#64748b)); border-radius:0.25rem; color:var(--omega-market-text,var(--vela-fg,#d1d4dc)); background:var(--omega-market-bg,var(--vela-bg,#131722)); font:inherit; font-weight:600; color-scheme:light dark; }
  .omega-market-flow-mode-select { width:100%; }
  .omega-market-flow-window-size { width:4.5rem; }
  .omega-market-flow-mode-select option { color:var(--omega-market-text,#d1d4dc); background:var(--omega-market-bg,#131722); }
  .omega-market-flow-mode-select:focus-visible,.omega-market-flow-window-size:focus-visible { outline:0.125rem solid var(--vela-accent,var(--omega-market-buy,#22c55e)); outline-offset:0.125rem; }
  .omega-market-flow-mode [hidden] { display:none; }
  .omega-market-flow-tick-row td { padding:0.25rem 0.125rem; }
  .omega-market-flow-tick-cell { width:32%; }
  .omega-market-flow-tick-cell.down .omega-market-flow-tick-track { justify-content:flex-end; }
  .omega-market-flow-tick-cell.up .omega-market-flow-tick-track { justify-content:flex-start; }
  .omega-market-flow-tick-track { position:relative; display:flex; align-items:center; width:100%; min-height:1.1rem; overflow:hidden; background:color-mix(in srgb,var(--omega-market-text,#d1d4dc) 7%,transparent); }
  .omega-market-flow-tick-bar { position:absolute; inset-block:0; opacity:.82; }
  .omega-market-flow-tick-bar.down { right:0; background:var(--omega-market-sell,#ef5350); }
  .omega-market-flow-tick-bar.up { left:0; background:var(--omega-market-buy,#22c55e); }
  .omega-market-flow-tick-value { position:absolute; z-index:1; top:50%; max-width:100%; overflow:hidden; padding-inline:0.25rem; color:#000; background:var(--omega-market-bg,var(--vela-bg,#131722)); font-size:calc(var(--omega-market-font-size,0.75rem) * 1.15); font-weight:700; text-shadow:none; white-space:nowrap; transform:translateY(-50%); }
  .omega-market-flow-tick-cell.down .omega-market-flow-tick-value { left:0; text-align:left; }
  .omega-market-flow-tick-cell.up .omega-market-flow-tick-value { right:0; text-align:right; }
  .omega-market-flow-tick-price { color:var(--omega-market-text,#d1d4dc); }
  .omega-market-flow-tick-totals { display:flex; justify-content:space-between; border-bottom:0.0625rem solid var(--omega-market-grid,var(--vela-border,#2a2e39)); padding:0.5rem 0.625rem; font:700 calc(var(--omega-market-font-size,0.75rem) * 1.3333) Consolas,monospace; }
  .omega-market-flow-tick-total.down { color:var(--omega-market-sell,#ef5350); }
  .omega-market-flow-tick-total.up { color:var(--omega-market-buy,#22c55e); }
  body[data-theme="light"] .omega-market-flow-tick-down,
  body[data-theme="light"] .omega-market-flow-tick-up,
  body[data-theme="light"] .omega-market-flow-tick-price,
  body[data-theme="light"] .omega-market-flow-tick-total { color:#000; }
  .omega-market-flow-spread { padding:0.625rem 0.5rem; border-block:0.0625rem solid var(--omega-market-grid,var(--vela-border,#2a2e39)); color:var(--omega-market-text,var(--vela-fg-bright,#f1f5f9)); font:700 calc(var(--omega-market-font-size,0.75rem) * 1.3333) Consolas,monospace; font-variant-numeric:tabular-nums; text-align:center; }
  .vela-panel.vela-panel-omega-time-sales .vela-panel-resizer,
  .vela-panel.vela-panel-omega-dom .vela-panel-resizer { left:-0.5rem; width:1rem; }
  .vela-panel.vela-panel-omega-time-sales .vela-panel-resizer::after,
  .vela-panel.vela-panel-omega-dom .vela-panel-resizer::after { left:0.4375rem; width:0.125rem; background:var(--vela-separator,var(--vela-border,#2a2e39)); }
  .vela-panel.vela-panel-omega-time-sales .vela-panel-resizer:hover::after,
  .vela-panel.vela-panel-omega-dom .vela-panel-resizer:hover::after,
  .vela-panel.vela-panel-omega-time-sales .vela-panel-resizer[data-dragging]::after,
  .vela-panel.vela-panel-omega-dom .vela-panel-resizer[data-dragging]::after { background:var(--vela-separator-hover-line,#5794f2); }
  /* Omega v4 — right edge: a little right padding moves the last column away
     from the panel border, and a distinctly thicker themed separator line sits
     at the panel's right edge behind the content. Theme-aware via
     --omega-separator, so it is visible in dark, light and both
     supported themes instead of an invisible hardcoded grey. */
  .vela-panel.vela-panel-omega-time-sales .omega-market-flow-table th:last-child,
  .vela-panel.vela-panel-omega-time-sales .omega-market-flow-table td:last-child,
  .vela-panel.vela-panel-omega-dom .omega-market-flow-table th:last-child,
  .vela-panel.vela-panel-omega-dom .omega-market-flow-table td:last-child { padding-right:1rem; }
  .vela-workspace .vela-panel.vela-panel-omega-time-sales,
  .vela-workspace .vela-panel.vela-panel-omega-dom { border-right:0.1875rem solid var(--omega-separator,var(--vela-separator,var(--vela-border,#3c5879))); }
`;
