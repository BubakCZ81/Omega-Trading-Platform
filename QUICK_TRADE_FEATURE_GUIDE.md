# Quick Trade Panel - Feature Guide

## Overview

The Quick Trade Panel is a draggable widget on your chart that enables rapid order placement with visual preview. It combines the speed of paper trading with interactive SL/TP adjustment.

## Visual Elements

### 1. Quick Trade Panel (Draggable Widget)
**Location**: Floating over your chart
**Content**:
- Buy/Sell toggle buttons
- Lot size input with +/- buttons
- Quick lot preset buttons (0.01, 0.10, 1.00, 5.00)
- Protection (SL/TP) section with mode selector (Pips/ATR)
- Current spread display
- Place order button

**Dragging**:
- Click and drag the header area to move the panel
- Panel snaps to valid positions
- Position persists between sessions

### 2. Chart Overlay - Trade Levels
**When you press BUY or SELL**:
- Green line appears at entry price
- Red line appears at stop loss price
- Green line appears at take profit price
- Lines extend from left chart edge to their price labels

### 3. Interactive Controls on Chart
**On the entry level (green line)**:
- **Pending Order** (before confirmation): 
  - X button - Cancel the pending order
- **Open Trade** (after confirmation):
  - ← button - Reverse position (sell to buy, or vice versa)
  - X button - Close the position

### 4. Order Preview Card
**Appears near the entry level when you place a trade**:
- **Title**: Shows trade details (symbol, volume, side)
- **SL/TP Preview**: Displays stop loss and take profit prices
- **Green Checkmark (✓)**: Confirm and execute the trade
- **Red X (✕)**: Cancel and close the preview
- **"Don't ask again" checkbox**: Skip this preview in future trades

**Animation**: Card pops in with a smooth scale animation

## Dragging SL and TP

### What You Can Adjust
1. **Stop Loss (Red Line)**: Adjust risk/loss amount
2. **Take Profit (Green Line)**: Adjust profit target

### How to Drag
1. **Find** the SL or TP level on the chart
2. **Click** on the level's label (right side of chart)
3. **Drag** up or down to adjust the price
4. **Release** when satisfied

### Visual Feedback
- Hovered controls highlight with brightness change
- Active drag shows smooth real-time updates
- Price updates display on the label as you drag
- Estimated loss/profit updates in the panel

## Workflow Example

### Scenario: Quick Scalp Trade on EURUSD

1. **Open Panel**
   - Quick Trade is already visible on your chart
   - If hidden, enable it from the chart's action menu

2. **Set Parameters**
   - Lots: 0.10 (click the 0.10 button)
   - Mode: Pips (already selected)
   - SL: 20 (already set)
   - TP: 40 (already set)

3. **Preview Trade**
   - Click BUY button
   - Chart shows entry + SL + TP levels
   - Preview card appears
   - You can see: "Buy 0.10 lots at current price"

4. **Adjust Protection (Optional)**
   - See SL is too tight (only 20 pips risk)
   - Drag the red SL line down to 30 pips
   - TP is good at 40 pips profit

5. **Confirm Trade**
   - Click the green ✓ button in the preview card
   - Trade executes immediately
   - Card closes, levels remain visible for open trade management

6. **Manage Trade**
   - See the entry (green), SL (red), TP (green) levels on chart
   - If price moves, SL and TP automatically adjust their display
   - Click entry level's ← to reverse, or X to close

7. **Reposition Panel (Optional)**
   - Drag the panel header to move it elsewhere
   - Position auto-saves for next session

## Keyboard Shortcuts

- **ESC**: Cancel current preview
- **Enter**: Confirm current preview (if open)

## Status Indicators

### Color Scheme
- **Green**: Buy side, Entry level, Take Profit, Confirm button, Success
- **Red**: Sell side, Stop Loss, Reversal/Close button, Cancel button, Loss
- **Blue/Accent**: Panel border when active

### Overlay Labels Format
```
[LABEL] ─────────┤
			│ Entry @ 1.0950
			│ SL @ 1.0920
			│ TP @ 1.0980
```

## Common Tasks

### Change Trade Direction
1. Currently on BUY? Click **SELL** button to switch
2. Panel updates color scheme to red
3. Entry level moves to current bid price

### Increase Risk
1. Drag **SL line** away from entry (downward for buy, upward for sell)
2. Watch "Estimated loss" increase in panel
3. Careful not to drag beyond account limits!

### Reduce Lot Size
1. Click **−** button under Volume, or
2. Manually type in the input field, or
3. Click a smaller quick lot button

### Save Panel Position
1. Drag panel to preferred location once
2. Position automatically saves to browser storage
3. Next session will remember your position

## Pro Tips

1. **Drag to a Corner**: Keep panel visible but out of chart view
2. **Use Quick Lots**: Preset buttons save time vs. manual typing
3. **Preview Every Time**: Catch mistakes before execution
4. **Multiple Timeframes**: Each chart remembers its panel position
5. **Practice First**: Enable Paper Trading mode, not live brokers

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Panel off-screen | Resize browser window or click Chart > Reset Layout |
| Can't drag panel | Click header bar (not buttons inside) and hold |
| Preview not appearing | Enable "Preview trades" in settings, or disable "Don't ask again" |
| Levels not updating | Try refreshing the chart or reconnecting data |
| Can't drag SL/TP | Make sure you're clicking the label text, not the line |

## Keyboard Navigation

- **Tab**: Move between inputs (lots, SL, TP, etc.)
- **Up/Down Arrows**: Adjust numeric inputs
- **Ctrl+A**: Select all in numeric field
- **Space**: Toggle Buy/Sell buttons

## Accessibility

- All buttons have ARIA labels for screen readers
- Trade direction clearly marked (BUY/SELL in distinct colors)
- Keyboard-only navigation supported
- High contrast in dark and light themes

---

**Ready to trade?** Enable Quick Trade from your chart menu and start placing orders! 🚀
