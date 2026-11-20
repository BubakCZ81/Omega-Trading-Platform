import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { applyTimeframe } from './timeframeSelection';
import { chartStyleCode, chartStyleName, formatTimeframeLabel } from './chartViewLabel';
import { HEIKIN_VARIANTS, isHeikinStyle } from './heikinMath';
import { getTpoSettings, setTpoSettings } from './tpoChart';
import { getFootprintSettings, setFootprintSettings } from './footprintChart';
import { reportCaughtError } from './diagnostics';
import {
  filterSymbolsByCategory,
  SYMBOL_PICKER_CATEGORIES,
  type SymbolPickerAsset,
  type SymbolPickerCategory,
} from './symbolPickerCategories';
import { loadPickerSymbols } from './symbolPickerData';

export const GROUP_COLOR_HEX: Record<string, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  purple: '#a855f7',
};

// Single source of truth for period labels. This module used to carry its own copy of
// this formatter, so a chart could label the very same period differently from the
// Timeframe menu the operator picked it from. Keep the public export, drop the duplicate.
export { formatTimeframeLabel };

function providerFromTradingAccount(accountId: string | null): string {
  if (!accountId) return '';
  const separator = accountId.indexOf(':');
  return separator > 0 ? accountId.slice(0, separator).trim().toLowerCase() : '';
}

export interface CellControlsDeps {
  getWorkspace: () => VelaWorkspace;
  getGroupForCell: (cellId: string) => string;
  onSetCellGroup: (cellId: string, group: string) => Promise<void>;
}

export class ChartCellControlsManager {
  private readonly mountedCells = new Set<string>();
  private readonly observers = new Map<string, MutationObserver>();
  private readonly marketSubscriptions = new Map<string, () => void>();
  private readonly styleSubscriptions = new Map<string, () => void>();
  private readonly activationHandlers = new Map<string, (event: PointerEvent) => void>();
  private activePopup: HTMLElement | null = null;
  private activePopupCellId: string | null = null;
  private readonly deps: CellControlsDeps;

  constructor(deps: CellControlsDeps) {
    this.deps = deps;
    document.addEventListener('omega:trading-account-selected', () => {
      if (this.activePopup?.querySelector('.omega-symbol-source-select')) this.closePopup();
    });
    document.addEventListener('pointerdown', event => {
      if (this.activePopup && !this.activePopup.contains(event.target as Node)) {
        this.closePopup();
      }
    });
  }

  public mountCell(cellId: string): void {
    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell || !cell.host) return;

    if (this.mountedCells.has(cellId)) {
      this.updateCell(cellId);
      return;
    }

    const host = cell.host;
    host.style.position = 'relative';

    const activateCell = (event: PointerEvent) => {
      // The chart renderer can stop bubbling pointer events, so close its asset
      // picker here in capture phase rather than relying only on the document handler.
      if (this.activePopup?.classList.contains('omega-symbol-picker')
        && !this.activePopup.contains(event.target as Node)) {
        this.closePopup();
      }
      // Keep top-toolbar menus from obscuring the chart after the trader returns
      // to it. Capture phase is required because Vela can stop pointer bubbling.
      const timeframeMenu = document.getElementById('ctrader-timeframe-menu') as HTMLDetailsElement | null;
      if (timeframeMenu?.open && !timeframeMenu.contains(event.target as Node)) {
        timeframeMenu.open = false;
      }
      const replayMenu = document.getElementById('replay-menu') as HTMLDetailsElement | null;
      if (replayMenu?.open && !replayMenu.contains(event.target as Node)) {
        replayMenu.open = false;
      }
      workspace.setActiveCell(cellId);
      this.updateAll();
    };
    host.addEventListener('pointerdown', activateCell, true);
    this.activationHandlers.set(cellId, activateCell);

    this.mountedCells.add(cellId);

    // Attach single set of controls directly to the upper-left status line (.vela-statusline)
    this.attachStatuslineIntegration(cellId);

    // Observe statusline changes to maintain interactive upper-left controls
    const observer = new MutationObserver(() => {
      this.attachStatuslineIntegration(cellId);
    });
    observer.observe(host, { childList: true, subtree: true });
    this.observers.set(cellId, observer);

    this.marketSubscriptions.set(cellId, cell.chart.on('market:changed', () => {
      this.attachStatuslineIntegration(cellId);
    }));
    this.styleSubscriptions.set(cellId, cell.chart.on('priceStyle:change', () => {
      this.attachStatuslineIntegration(cellId);
    }));

    this.updateCell(cellId);
  }

  public unmountCell(cellId: string): void {
    if (this.activePopupCellId === cellId) this.closePopup();
    this.mountedCells.delete(cellId);
    const obs = this.observers.get(cellId);
    if (obs) {
      obs.disconnect();
      this.observers.delete(cellId);
    }
    this.marketSubscriptions.get(cellId)?.();
    this.marketSubscriptions.delete(cellId);
    this.styleSubscriptions.get(cellId)?.();
    this.styleSubscriptions.delete(cellId);
    const handler = this.activationHandlers.get(cellId);
    const host = this.deps.getWorkspace().cell(cellId)?.host;
    if (handler && host) host.removeEventListener('pointerdown', handler, true);
    this.activationHandlers.delete(cellId);
  }

  public attachStatuslineIntegration(cellId: string): void {
    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell || !cell.host) return;

    const statusline = cell.host.querySelector<HTMLElement>('.vela-statusline');
    if (!statusline) return;

    const row = statusline.querySelector<HTMLElement>('.vela-sl-row');
    const symbolEl = statusline.querySelector<HTMLElement>('.vela-sl-symbol');
    if (!row || !symbolEl) return;

    // Keep the selected value visible, but make the control's purpose explicit
    // when a chart tab becomes active.
    const selectedSymbol = cell.chart.market.symbol?.trim() || '—';
    const selectedAsset = cell.chart.data.resolve(selectedSymbol)?.ticker?.trim() || selectedSymbol;
    const assetSelectorLabel = selectedAsset;
    if (symbolEl.textContent !== assetSelectorLabel) symbolEl.textContent = assetSelectorLabel;

    const group = this.deps.getGroupForCell(cellId) || '';
    const color = group ? (GROUP_COLOR_HEX[group] ?? '') : '';

    // 1. Group Square inside upper-left statusline
    let groupSquare = row.querySelector<HTMLSpanElement>('.omega-statusline-group-square');
    if (!groupSquare) {
      groupSquare = document.createElement('span');
      groupSquare.className = 'omega-statusline-group-square';
      groupSquare.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.openGroupMenu(cellId, groupSquare!);
      });
      row.insertBefore(groupSquare, symbolEl);
    }

    if (color) {
      groupSquare.style.backgroundColor = color;
      groupSquare.style.borderColor = 'rgba(255, 255, 255, 0.4)';
      groupSquare.title = `Group: ${group.toUpperCase()} (Click to change)`;
    } else {
      groupSquare.style.backgroundColor = 'transparent';
      groupSquare.style.borderColor = 'rgba(148, 163, 184, 0.5)';
      groupSquare.title = 'No Group (Click to assign)';
    }

    // 2. Make upper-left symbol interactive and clickable
    if (!symbolEl.dataset.omegaSymbolInteractive) {
      symbolEl.dataset.omegaSymbolInteractive = 'true';
      symbolEl.style.cursor = 'pointer';
      symbolEl.title = 'Asset selector — click to change the selected asset';
      symbolEl.classList.add('omega-statusline-symbol');

      symbolEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.openSymbolPickerForCell(cellId, symbolEl);
      });
    }

    // 3. Make upper-left timeframe interactive
    const metaEl = statusline.querySelector<HTMLElement>('.vela-sl-meta');
    if (metaEl && !metaEl.dataset.omegaMetaInteractive) {
      metaEl.dataset.omegaMetaInteractive = 'true';
      metaEl.style.cursor = 'pointer';
      metaEl.title = 'Click to change timeframe for this chart';
      metaEl.classList.add('omega-statusline-meta');
      metaEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.openTimeframeMenu(cellId, metaEl);
      });
    }

    // 4. Compact chart-type + period code inside every chart's own statusline:
    //    Hm5 (Heikin 5m), 5m (candles).
    if (metaEl) {
      const timeframe = cell.chart.market.timeframe ?? '60';
      // Vela writes the broker and the period with its own vocabulary,
      // which does not match the period the operator picked in the Timeframe menu.
      // Re-render both from the same formatter so the chart can never display a timeframe
      // that differs from the selected one. This handler runs after Vela's own statusline
      // update because the statusline subscribes during widget construction.
      const provider = metaEl.textContent
        ?.split('·')
        .map(part => part.trim())
        .filter(Boolean)[0] ?? '';
      const period = formatTimeframeLabel(timeframe);
      const canonicalMeta = 'Timeframe';
      if (metaEl.textContent !== canonicalMeta) metaEl.textContent = canonicalMeta;
      // The chart statusline is the timeframe control, not an exchange/provider label.
      // Remove stale values such as NASDAQ when switching to Eurex or another feed.
      if (metaEl.textContent !== 'Timeframe') metaEl.textContent = 'Timeframe';

      let styleChip = row.querySelector<HTMLElement>('.omega-statusline-style');
      if (!styleChip) {
        styleChip = document.createElement('span');
        styleChip.className = 'omega-statusline-style';
        styleChip.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
          const cell = this.deps.getWorkspace().cell(cellId);
          const current = String(cell?.chart.renderer.get('priceStyle') ?? 'candles');
          // When a custom price style is active, clicking the chip opens its settings
          if (isHeikinStyle(current)) this.openHeikinMenu(cellId, styleChip!, current);
          else if (current === 'tpo') this.openTpoMenu(cellId, styleChip!);
          else if (current === 'footprint') this.openFootprintMenu(cellId, styleChip!);
          else this.openTimeframeMenu(cellId, styleChip!);
        });
        metaEl.insertAdjacentElement('afterend', styleChip);
      }
      const style = String(cell.chart.renderer.get('priceStyle') ?? 'candles');
      const code = chartStyleCode(style, timeframe);
      // A plain candle chart is already described by the period in the meta text, so a
      // second identical chip would read as a second, competing timeframe.
      const duplicatesPeriod = code === period;
      styleChip.hidden = duplicatesPeriod;
      if (styleChip.textContent !== code) styleChip.textContent = code;
      styleChip.title = `${chartStyleName(style)} · ${period} — click to change settings or style`;
    }
  }

  public updateCell(cellId: string): void {
    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell) return;

    const group = this.deps.getGroupForCell(cellId) || '';
    const color = group ? (GROUP_COLOR_HEX[group] ?? '') : '';

    this.attachStatuslineIntegration(cellId);

    // Active outline state
    const isActive = workspace.active?.id === cellId;
    if (isActive) {
      cell.host.dataset.omegaActive = 'true';
      cell.host.dataset.active = '1';
    } else {
      delete cell.host.dataset.omegaActive;
      if (workspace.active?.id !== cellId) {
        delete cell.host.dataset.active;
      }
    }
    const borderColor = color || '#4778ffff';
    cell.host.style.setProperty('--active-chart-border', borderColor);
    cell.host.style.setProperty('--active-chart-glow', color ? `${color}66` : 'rgba(41, 98, 255, 0.35)');
    if (color) {
      cell.host.style.setProperty('--vela-cell-group-color', color);
      cell.host.dataset.groupColor = group;
    } else {
      cell.host.style.removeProperty('--vela-cell-group-color');
      delete cell.host.dataset.groupColor;
    }
  }

  public updateAll(): void {
    const workspace = this.deps.getWorkspace();
    for (const cell of workspace.cells()) {
      this.updateCell(cell.id);
    }
  }

  private closePopup(): void {
    if (this.activePopup) {
      this.activePopup.remove();
      this.activePopup = null;
      this.activePopupCellId = null;
    }
  }

  private openGroupMenu(cellId: string, anchor: HTMLElement): void {
    this.closePopup();

    const currentGroup = this.deps.getGroupForCell(cellId) || '';
    const menu = document.createElement('div');
    menu.className = 'omega-cell-popup omega-group-menu';

    const title = document.createElement('div');
    title.className = 'omega-popup-title';
    title.textContent = 'Chart Grouping';
    menu.appendChild(title);

    const options: Array<{ id: string; label: string; color: string }> = [
      { id: '', label: 'None (Unlink)', color: 'transparent' },
      { id: 'red', label: 'Red Group', color: GROUP_COLOR_HEX.red },
      { id: 'blue', label: 'Blue Group', color: GROUP_COLOR_HEX.blue },
      { id: 'green', label: 'Green Group', color: GROUP_COLOR_HEX.green },
      { id: 'yellow', label: 'Yellow Group', color: GROUP_COLOR_HEX.yellow },
      { id: 'purple', label: 'Purple Group', color: GROUP_COLOR_HEX.purple },
    ];

    for (const opt of options) {
      const item = document.createElement('button');
      item.className = 'omega-group-item';
      if (opt.id === currentGroup) item.classList.add('selected');

      const swatch = document.createElement('span');
      swatch.className = 'omega-group-item-swatch';
      swatch.style.backgroundColor = opt.color;
      if (!opt.id) {
        swatch.style.border = '0.0625rem dashed #94a3b8';
      }

      const text = document.createElement('span');
      text.textContent = opt.label;

      item.append(swatch, text);

      item.addEventListener('click', async () => {
        this.closePopup();
        await this.deps.onSetCellGroup(cellId, opt.id);
        this.updateAll();
      });

      menu.appendChild(item);
    }

    this.positionPopup(menu, anchor, cellId);
  }

  public openSymbolPickerForCell(cellId: string, anchor: HTMLElement): void {
    if (!this.deps.getWorkspace().cell(cellId)) return;
    this.closePopup();
    this.openSymbolFallback(cellId, anchor);
  }

  /**
   * Heikin Ashi calculation settings, opened from the chart's own style chip.
   *
   * A dialog that appears only when the style is chosen forces the operator back through
   * Timeframe → Heikin Ashi → settings just to adjust smoothing. The chip is visible for as
   * long as Heikin Ashi is active, so the setting stays one click away, on the chart it
   * applies to.
   */
  private openHeikinMenu(cellId: string, anchor: HTMLElement, currentStyle: string): void {
    this.closePopup();
    const cell = this.deps.getWorkspace().cell(cellId);
    if (!cell) return;

    const menu = document.createElement('div');
    menu.className = 'omega-cell-popup omega-heikin-menu';

    const title = document.createElement('div');
    title.className = 'omega-popup-title';
    title.textContent = 'Heikin Ashi calculation';
    menu.appendChild(title);

    const selectedId = currentStyle === 'heikinashi' ? 'heikin-standard' : currentStyle;
    for (const variant of HEIKIN_VARIANTS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'omega-heikin-item';
      if (variant.id === selectedId) item.classList.add('selected');
      const name = document.createElement('strong');
      name.textContent = variant.label.replace('Heikin Ashi ', '');
      const note = document.createElement('span');
      note.textContent = variant.description;
      item.append(name, note);
      item.addEventListener('click', () => {
        this.closePopup();
        cell.chart.renderer.set('priceStyle', variant.id);
        this.updateCell(cellId);
      });
      menu.appendChild(item);
    }

    const candles = document.createElement('button');
    candles.type = 'button';
    candles.className = 'omega-heikin-item omega-heikin-candles';
    candles.textContent = 'Back to standard candles';
    candles.addEventListener('click', () => {
      this.closePopup();
      cell.chart.renderer.set('priceStyle', 'candles');
      this.updateCell(cellId);
    });
    menu.appendChild(candles);

    this.positionPopup(menu, anchor, cellId);
  }

  private openTpoMenu(cellId: string, anchor: HTMLElement): void {
    this.closePopup();
    const cell = this.deps.getWorkspace().cell(cellId);
    if (!cell) return;

    const menu = document.createElement('div');
    menu.className = 'omega-cell-popup omega-heikin-menu';

    const title = document.createElement('div');
    title.className = 'omega-popup-title';
    title.textContent = 'Time At Price Settings';
    menu.appendChild(title);

    const brackets = [
      { count: 12, label: '12 Price Brackets (Wide)' },
      { count: 18, label: '18 Price Brackets (Standard)' },
      { count: 24, label: '24 Price Brackets (Detailed)' },
      { count: 32, label: '32 Price Brackets (Fine)' },
    ];

    const currentSettings = getTpoSettings();
    for (const b of brackets) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'omega-heikin-item';
      if (currentSettings.rowCount === b.count) item.classList.add('selected');
      const name = document.createElement('strong');
      name.textContent = b.label;
      item.append(name);
      item.addEventListener('click', () => {
        setTpoSettings({ rowCount: b.count });
        this.closePopup();
        cell.chart.renderer.set('priceStyle', 'tpo');
        this.updateCell(cellId);
      });
      menu.appendChild(item);
    }

    const candles = document.createElement('button');
    candles.type = 'button';
    candles.className = 'omega-heikin-item omega-heikin-candles';
    candles.textContent = 'Back to standard candles';
    candles.addEventListener('click', () => {
      this.closePopup();
      cell.chart.renderer.set('priceStyle', 'candles');
      this.updateCell(cellId);
    });
    menu.appendChild(candles);

    this.positionPopup(menu, anchor, cellId);
  }

  private openFootprintMenu(cellId: string, anchor: HTMLElement): void {
    this.closePopup();
    const cell = this.deps.getWorkspace().cell(cellId);
    if (!cell) return;

    const menu = document.createElement('div');
    menu.className = 'omega-cell-popup omega-heikin-menu';

    const title = document.createElement('div');
    title.className = 'omega-popup-title';
    title.textContent = 'Footprint Settings';
    menu.appendChild(title);

    const currentSettings = getFootprintSettings();

    const repaint = () => {
      cell.chart.renderer.set('priceStyle', 'footprint');
      this.updateCell(cellId);
    };

    // --- Mode Selector (buttons) ---
    const modes = [
      { mode: 'bidask' as const, label: 'Bid × Ask (Order Flow)' },
      { mode: 'delta' as const, label: 'Delta Bars' },
      { mode: 'profile' as const, label: 'Volume Profile' },
    ];
    for (const m of modes) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'omega-heikin-item';
      if (currentSettings.mode === m.mode) item.classList.add('selected');
      const name = document.createElement('strong');
      name.textContent = m.label;
      item.append(name);
      item.addEventListener('click', () => {
        setFootprintSettings({ mode: m.mode });
        repaint();
      });
      menu.appendChild(item);
    }

    // --- Helper to create a settings row ---
    const createRow = (labelText: string): HTMLDivElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 12px;gap:8px;';
      const lbl = document.createElement('label');
      lbl.style.cssText = 'color:var(--omega-text, #1d2938);font-size:12px;white-space:nowrap;';
      lbl.textContent = labelText;
      row.appendChild(lbl);
      return row;
    };

    // --- Price Rows (number input) ---
    const rowsRow = createRow('Price Rows');
    const rowsInput = document.createElement('input');
    rowsInput.type = 'number';
    rowsInput.min = '4';
    rowsInput.max = '32';
    rowsInput.step = '1';
    rowsInput.value = String(currentSettings.rowCount ?? 10);
    rowsInput.style.cssText = 'width:60px;background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 6px;font-size:12px;';
    rowsInput.addEventListener('input', () => {
      const v = Math.max(4, Math.min(32, Number(rowsInput.value) || 10));
      setFootprintSettings({ rowCount: v });
      repaint();
    });
    rowsRow.appendChild(rowsInput);
    menu.appendChild(rowsRow);

    // --- Font Size (number input) ---
    const fontRow = createRow('Font Size (px)');
    const fontInput = document.createElement('input');
    fontInput.type = 'number';
    fontInput.min = '4';
    fontInput.max = '20';
    fontInput.step = '1';
    fontInput.value = String(currentSettings.fontSize ?? 14);
    fontInput.style.cssText = 'width:60px;background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 6px;font-size:12px;';
    fontInput.addEventListener('input', () => {
      const v = Math.max(4, Math.min(20, Number(fontInput.value) || 14));
      setFootprintSettings({ fontSize: v });
      repaint();
    });
    fontRow.appendChild(fontInput);
    menu.appendChild(fontRow);

    const textZoomRow = createRow('Show Text Up To Candles on Screen');
    const textZoom = document.createElement('input');
    textZoom.type = 'number';
    textZoom.min = '1';
    textZoom.max = '200';
    textZoom.step = '1';
    textZoom.value = String(currentSettings.textMaxVisibleCandles ?? 10);
    textZoom.style.cssText = 'width:60px;background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 6px;font-size:12px;';
    textZoom.addEventListener('input', () => {
      setFootprintSettings({ textMaxVisibleCandles: Math.max(1, Math.min(200, Number(textZoom.value) || 10)) });
      repaint();
    });
    textZoomRow.appendChild(textZoom);
    menu.appendChild(textZoomRow);

    // --- Bull Text Color (color picker) ---
    const bullTextRow = createRow('Bull Text Color');
    const bullTextColor = document.createElement('input');
    bullTextColor.type = 'color';
    bullTextColor.value = currentSettings.bullTextColor ?? '#86efac';
    bullTextColor.style.cssText = 'width:32px;height:24px;padding:0;border:none;cursor:pointer;background:transparent;';
    bullTextColor.addEventListener('input', () => {
      setFootprintSettings({ bullTextColor: bullTextColor.value });
      repaint();
    });
    bullTextRow.appendChild(bullTextColor);
    menu.appendChild(bullTextRow);

    // --- Bear Text Color (color picker) ---
    const bearTextRow = createRow('Bear Text Color');
    const bearTextColor = document.createElement('input');
    bearTextColor.type = 'color';
    bearTextColor.value = currentSettings.bearTextColor ?? '#fca5a5';
    bearTextColor.style.cssText = 'width:32px;height:24px;padding:0;border:none;cursor:pointer;background:transparent;';
    bearTextColor.addEventListener('input', () => {
      setFootprintSettings({ bearTextColor: bearTextColor.value });
      repaint();
    });
    bearTextRow.appendChild(bearTextColor);
    menu.appendChild(bearTextRow);

    // --- Bull Cell Color (color picker) ---
    const bullCellRow = createRow('Bull Cell Color');
    const bullCellColor = document.createElement('input');
    bullCellColor.type = 'color';
    bullCellColor.value = currentSettings.bullColor ?? '#22c55e';
    bullCellColor.style.cssText = 'width:32px;height:24px;padding:0;border:none;cursor:pointer;background:transparent;';
    bullCellColor.addEventListener('input', () => {
      setFootprintSettings({ bullColor: bullCellColor.value });
      repaint();
    });
    bullCellRow.appendChild(bullCellColor);
    menu.appendChild(bullCellRow);

    // --- Bear Cell Color (color picker) ---
    const bearCellRow = createRow('Bear Cell Color');
    const bearCellColor = document.createElement('input');
    bearCellColor.type = 'color';
    bearCellColor.value = currentSettings.bearColor ?? '#ef4444';
    bearCellColor.style.cssText = 'width:32px;height:24px;padding:0;border:none;cursor:pointer;background:transparent;';
    bearCellColor.addEventListener('input', () => {
      setFootprintSettings({ bearColor: bearCellColor.value });
      repaint();
    });
    bearCellRow.appendChild(bearCellColor);
    menu.appendChild(bearCellRow);

    const pocColorRow = createRow('POC Outline Color');
    const pocColor = document.createElement('input');
    pocColor.type = 'color';
    pocColor.value = currentSettings.pocColor ?? '#eab308';
    pocColor.style.cssText = 'width:32px;height:24px;padding:0;border:none;cursor:pointer;background:transparent;';
    pocColor.addEventListener('input', () => {
      setFootprintSettings({ pocColor: pocColor.value });
      repaint();
    });
    pocColorRow.appendChild(pocColor);
    menu.appendChild(pocColorRow);

    const pocWidthRow = createRow('POC Outline Thickness');
    const pocWidth = document.createElement('input');
    pocWidth.type = 'number';
    pocWidth.min = '1';
    pocWidth.max = '5';
    pocWidth.step = '0.5';
    pocWidth.value = String(currentSettings.pocLineWidth ?? 2);
    pocWidth.style.cssText = 'width:60px;background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 6px;font-size:12px;';
    pocWidth.addEventListener('input', () => {
      setFootprintSettings({ pocLineWidth: Math.max(1, Math.min(5, Number(pocWidth.value) || 2)) });
      repaint();
    });
    pocWidthRow.appendChild(pocWidth);
    menu.appendChild(pocWidthRow);

    // --- Back to standard candles ---
    const candles = document.createElement('button');
    candles.type = 'button';
    candles.className = 'omega-heikin-item omega-heikin-candles';
    candles.textContent = 'Back to standard candles';
    candles.addEventListener('click', () => {
      this.closePopup();
      cell.chart.renderer.set('priceStyle', 'candles');
      this.updateCell(cellId);
    });
    menu.appendChild(candles);

    this.positionPopup(menu, anchor, cellId);
  }

  private openSymbolFallback(cellId: string, anchor: HTMLElement): void {
    const picker = document.createElement('div');
    picker.className = 'omega-cell-popup omega-symbol-picker';

    const search = document.createElement('input');
    search.className = 'omega-symbol-search-input';
    search.type = 'search';
    search.placeholder = 'Search or enter a symbol';
    search.setAttribute('aria-label', 'Search assets');
    const source = document.createElement('select');
    source.className = 'omega-symbol-source-select';
    source.setAttribute('aria-label', 'Market data source');
    const list = document.createElement('div');
    list.className = 'omega-symbol-list';
    const groupsBar = document.createElement('div');
    groupsBar.className = 'omega-symbol-group-tabs';
    picker.append(source, search, groupsBar, list);

    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell) return;
    const providers = cell.chart.data.providers();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All connected feeds';
    // A selected trading account means exactly one broker may supply instruments, so the
    // source list is locked to it: an operator must never be offered another broker's assets
    // so the source list stays limited to the selected broker's instruments.
    const account = document.querySelector<HTMLSelectElement>('#trading-account-select')?.value
      || localStorage.getItem('omega.selected-trading-account');
    const brokerLock = providerFromTradingAccount(account);
    if (brokerLock) {
      const lockedOption = document.createElement('option');
      lockedOption.value = brokerLock;
      const lockedProvider = providers.find(provider => provider.name.toLowerCase() === brokerLock);
      lockedOption.textContent = lockedProvider?.displayName ?? `${brokerLock} (not connected)`;
      source.append(lockedOption);
      source.disabled = true;
      source.title = `${lockedOption.textContent} is the selected broker, so only its instruments are listed.`;
    } else {
      source.append(all);
      for (const provider of providers) {
        const option = document.createElement('option');
        option.value = provider.name.toLowerCase();
        option.textContent = provider.displayName ?? provider.name;
        source.append(option);
      }
    }
    source.value = brokerLock;
    if (!brokerLock) source.disabled = providers.length === 0;

    const selectedProvider = () => source.value.trim().toLowerCase();

    let selectedGroup: 'All' | SymbolPickerCategory = 'All';
    let displayedSymbolLimit = 200;
    let symbolsByProvider: Map<string, SymbolPickerAsset[]> = new Map(providers.map(item => [
      item.name.toLowerCase(),
      cell.chart.data.symbols(item.name).map(symbol => ({ ...symbol, provider: item.name.toLowerCase() })),
    ]));
    let symbolLoadErrors = new Map<string, string>();
    let loadingProviders = new Set<string>();
    let loadSequence = 0;
    const refreshSymbols = async (names: string[]) => {
      const sequence = ++loadSequence;
      const actualNames = names.map(name =>
        providers.find(item => item.name.toLowerCase() === name.toLowerCase())?.name ?? name);
      loadingProviders = new Set(actualNames.map(name => name.toLowerCase()));
      symbolLoadErrors = new Map();
      render();
      const loaded = await loadPickerSymbols(cell.chart.data, actualNames);
      if (sequence !== loadSequence || !picker.isConnected) return;
      symbolsByProvider = new Map([
        ...symbolsByProvider,
        ...[...loaded.symbols].map(([name, symbols]) => [name.toLowerCase(), symbols] as const),
      ]);
      symbolLoadErrors = new Map([...loaded.errors].map(([name, error]) => [name.toLowerCase(), error]));
      loadingProviders.clear();
      render();
    };
    const render = () => {
      const query = search.value.trim().toUpperCase();
      list.replaceChildren();
      const provider = selectedProvider();
      const symbols = provider
        ? symbolsByProvider.get(provider) ?? []
        : [...symbolsByProvider.values()].flat();
      groupsBar.replaceChildren();
      for (const groupName of ['All', ...SYMBOL_PICKER_CATEGORIES] as const) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'omega-symbol-group-tab';
        const categoryCount = groupName === 'All'
          ? symbols.length
          : filterSymbolsByCategory(symbols, '', groupName).length;
        tab.textContent = `${groupName} (${categoryCount})`;
        tab.classList.toggle('selected', groupName === selectedGroup);
        tab.addEventListener('click', () => {
          selectedGroup = groupName;
          displayedSymbolLimit = 200;
          render();
        });
        groupsBar.append(tab);
      }
      const matches = filterSymbolsByCategory(symbols, query, selectedGroup);
      const connected = providers.some(item => item.name.toLowerCase() === provider);
      const loading = provider
        ? loadingProviders.has(provider)
        : [...loadingProviders].some(name => providers.some(item => item.name.toLowerCase() === name));
      const loadError = provider
        ? symbolLoadErrors.get(provider)
        : [...symbolLoadErrors.entries()].map(([name, message]) => `${name}: ${message}`).join('; ');
      if (loading && !symbols.length) {
        const pending = document.createElement('div');
        pending.className = 'omega-symbol-empty';
        pending.textContent = 'Loading symbols from connected feeds…';
        list.append(pending);
      }
      if (loadError) {
        const error = document.createElement('div');
        error.className = 'omega-symbol-empty';
        error.dataset.state = 'error';
        error.textContent = `Could not refresh every symbol list: ${loadError}`;
        list.append(error);
      }
      if (query && (!provider || connected) && !matches.some(item => item.ticker.toUpperCase() === query)) {
        const custom = document.createElement('button');
        custom.type = 'button';
        custom.className = 'omega-symbol-item custom-match';
        const target = provider ? `${provider}:${query}` : query;
        custom.textContent = `Use ${target}`;
        custom.addEventListener('click', () => this.applySymbol(cellId, target));
        list.append(custom);
      }
      if (!matches.length && !query) {
        const empty = document.createElement('div');
        empty.className = 'omega-symbol-empty';
        empty.textContent = provider && !connected
          ? `${provider} is selected as the trading account, but its market-data feed is not connected. Connect it from the Broker or Data Feeds panel.`
          : provider
            ? 'This feed has no loaded symbols yet.'
            : 'No connected feeds are available.';
        list.append(empty);
      }
      // Categories are the horizontal tabs above. Do not repeat them as tall,
      // vertical sections: the picker must remain a fast flat list.
      for (const item of matches.slice(0, displayedSymbolLimit)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'omega-symbol-item';
          const main = document.createElement('span');
          main.className = 'omega-symbol-main';
          const symbol = document.createElement('strong');
          symbol.textContent = item.ticker;
          const name = document.createElement('small');
          name.textContent = item.description ?? item.ticker;
          main.append(symbol, name);
          const providerLabel = document.createElement('span');
          providerLabel.className = 'omega-symbol-cat';
          providerLabel.textContent = item.provider ?? provider ?? item.type ?? '';
          button.append(main, providerLabel);
          // Use the provider's OWN prefix (the descriptor carries it). Building a lowercase
          // `${provider}:${ticker}` produced `mt5:EURUSD` while the MT5 feed registers its
          // symbols as `MT5:EURUSD`, so the chart refused to resolve the instrument and the
          // click did nothing.
          const owner = item.prefix ?? item.provider ?? provider ?? '';
          const target = owner ? `${owner}:${item.ticker}` : item.ticker;
          button.addEventListener('click', () => this.applySymbol(cellId, target));
          list.append(button);
      }
      if (matches.length > displayedSymbolLimit) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'omega-symbol-item omega-symbol-load-more';
        more.textContent = `Show more symbols (${displayedSymbolLimit} of ${matches.length})`;
        more.addEventListener('click', () => {
          displayedSymbolLimit = Math.min(matches.length, displayedSymbolLimit + 200);
          render();
        });
        list.append(more);
      }
    };
    search.addEventListener('input', () => {
      displayedSymbolLimit = 200;
      render();
    });
    source.addEventListener('change', () => {
      search.value = '';
      displayedSymbolLimit = 200;
      render();
      const provider = selectedProvider();
      void refreshSymbols(provider ? [provider] : providers.map(item => item.name));
      search.focus();
    });
    search.addEventListener('keydown', event => {
      if (event.key === 'Enter' && search.value.trim()) {
        const ticker = search.value.trim().toUpperCase();
        const provider = selectedProvider();
        const owner = provider ? (provider.toLowerCase() === 'mt5' ? 'MT5' : provider) : '';
        this.applySymbol(cellId, owner ? `${owner}:${ticker}` : ticker);
      }
    });
    render();
    void refreshSymbols(brokerLock ? [brokerLock] : providers.map(item => item.name));
    this.positionPopup(picker, anchor, cellId);
    search.focus();
  }

  private openTimeframeMenu(cellId: string, anchor: HTMLElement): void {
    this.closePopup();

    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell) return;

    const popup = document.createElement('div');
    popup.className = 'omega-cell-popup omega-tf-menu';

    // The chart statusline opens the SAME full period/type selector as the
    // toolbar (standard periods, ticks, Heikin Ashi) instead of a
    // reduced list. Activate the clicked cell first: the toolbar handlers apply
    // to the active chart.
    const fullGrid = document.getElementById('ctrader-timeframe-grid');
    if (fullGrid) {
      if (workspace.active?.id !== cellId) workspace.setActiveCell(cellId);
      popup.classList.add('omega-tf-full');
      const clone = fullGrid.cloneNode(true) as HTMLElement;
      clone.removeAttribute('id');
      clone.querySelectorAll<HTMLElement>('[id]').forEach(element => element.removeAttribute('id'));
      // Tick periods need MetaTrader's one-tick input; explain instead of
      // silently ignoring the click.
      if (cell.chart.data.resolve(cell.chart.market.symbol ?? '')?.provider !== 'mt5') {
        for (const tickButton of clone.querySelectorAll<HTMLButtonElement>('button[data-timeframe^="T"]')) {
          tickButton.disabled = true;
          tickButton.title = 'Tick bars require a connected MetaTrader 5 symbol.';
        }
      }
      clone.addEventListener('click', event => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-style]');
        if (!button) return;
        event.preventDefault();
        const match = [...fullGrid.querySelectorAll<HTMLButtonElement>('button[data-style]')].find(candidate =>
          candidate.dataset.style === button.dataset.style
          && (button.dataset.timeframe ? candidate.dataset.timeframe === button.dataset.timeframe : !candidate.dataset.timeframe)
          && (button.dataset.pips ? candidate.dataset.pips === button.dataset.pips : !candidate.dataset.pips));
        this.closePopup();
        match?.click();
        this.updateCell(cellId);
      });
      popup.append(clone);

      const custom = this.buildCustomTimeframeForm((timeframe) => {
        void applyTimeframe(cell.chart, timeframe).then(() => {
          this.closePopup();
          this.updateCell(cellId);
        });
      });
      popup.append(custom);
      this.positionPopup(popup, anchor, cellId);
      return;
    }

    const currentTf = cell.chart.market.timeframe ?? '60';
    const sections = [
      { title: 'Minutes', options: [['1m', '1'], ['2m', '2'], ['3m', '3'], ['5m', '5'], ['10m', '10'], ['15m', '15'], ['30m', '30']] },
      { title: 'Hours', options: [['1h', '60'], ['2h', '120'], ['3h', '180'], ['4h', '240'], ['6h', '360'], ['8h', '480'], ['12h', '720']] },
      { title: 'Days', options: [['1D', 'D'], ['2D', '2880'], ['3D', '4320'], ['1W', 'W'], ['1M', 'M']] },
    ] as const;

    const choose = async (timeframe: string) => {
      await applyTimeframe(cell.chart, timeframe);
      this.closePopup();
      this.updateCell(cellId);
    };

    for (const section of sections) {
      const heading = document.createElement('span');
      heading.className = 'omega-tf-heading';
      heading.textContent = section.title;
      popup.appendChild(heading);
      for (const [label, value] of section.options) {
      const btn = document.createElement('button');
      btn.className = 'omega-tf-item';
      if (value === currentTf) {
        btn.classList.add('selected');
      }
      btn.textContent = label;

      btn.addEventListener('click', () => {
        void choose(value);
      });

      popup.appendChild(btn);
      }
    }

    popup.append(this.buildCustomTimeframeForm((timeframe) => { void choose(timeframe); }));

    this.positionPopup(popup, anchor, cellId);
  }

  private buildCustomTimeframeForm(onApply: (timeframe: string) => void): HTMLFormElement {
    const custom = document.createElement('form');
    custom.className = 'omega-tf-custom';
    const customInput = document.createElement('input');
    customInput.type = 'number';
    customInput.min = '1';
    customInput.max = '1440';
    customInput.placeholder = 'Custom minutes';
    customInput.inputMode = 'numeric';
    const apply = document.createElement('button');
    apply.type = 'submit';
    apply.textContent = 'Apply';
    custom.append(customInput, apply);
    custom.addEventListener('submit', event => {
      event.preventDefault();
      const minutes = Number(customInput.value);
      if (Number.isSafeInteger(minutes) && minutes > 0 && minutes <= 1440) onApply(String(minutes));
      else customInput.setCustomValidity('Enter whole minutes from 1 to 1440.');
    });
    return custom;
  }

  private applySymbol(cellId: string, symbol: string): void {
    this.closePopup();
    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell) return;

    // Apply symbol ONLY (preserves existing timeframe). A rejected load must be visible:
    // silently doing nothing is exactly the "I click an asset and the chart never changes"
    // report.
    void cell.chart.setMarket({ symbol }).catch(error => {
      reportCaughtError('chart:symbol-change', error, `Could not switch this chart to ${symbol}.`);
      try {
        workspace.toast(`Could not load ${symbol}: ${error instanceof Error ? error.message : String(error)}`, 'error');
      } catch (toastError) {
        reportCaughtError('chart:symbol-toast', toastError);
      }
    });
    this.updateCell(cellId);

    // If part of group, also update symbol on same-group cells (each preserves its OWN timeframe!)
    const group = this.deps.getGroupForCell(cellId);
    if (group) {
      for (const other of workspace.cells()) {
        if (other.id !== cellId && this.deps.getGroupForCell(other.id) === group) {
          void other.chart.setMarket({ symbol }).catch((error: unknown) => {
            reportCaughtError('chart:symbol-change-grouped', error, `Grouped chart ${other.id} did not accept ${symbol}.`);
          });
          this.updateCell(other.id);
        }
      }
    }
  }

  private positionPopup(popup: HTMLElement, anchor: HTMLElement, cellId: string): void {
    document.body.appendChild(popup);
    this.activePopup = popup;
    this.activePopupCellId = cellId;

    const rect = anchor.getBoundingClientRect();
    const popupWidth = popup.offsetWidth || 240;

    let left = rect.left;
    let top = rect.bottom + 4;

    // Boundary protection
    if (left + popupWidth > window.innerWidth - 10) {
      left = window.innerWidth - popupWidth - 10;
    }
    if (left < 10) left = 10;

    const popupHeight = popup.offsetHeight || 0;
    if (top + popupHeight > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - popupHeight - 10);
    }

    popup.style.position = 'fixed';
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }
}
