import datetime
import glob
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import uuid

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None


# MetaTrader rejects a single copy_rates_from_pos call asking for tens of thousands of bars
# with (-2, 'Terminal: Invalid params'); paging below keeps every size working.
MAX_RATES_PER_CALL = 5000
# Sleep between tick polls only when no ticks were returned (burst-drain optimisation
# in run_tick_stream re-polls immediately while the terminal keeps emitting ticks).
# 5 ms is the minimum useful granularity for Windows event timers; going lower adds
# CPU spin without reducing real-world latency.
TICK_STREAM_POLL_SECONDS = 0.005
MAX_INTENT_AGE_MS = 15_000
MAX_ORDER_QUOTE_AGE_MS = 30_000
DEFAULT_MAX_ORDER_VOLUME = 1000.0
MAX_CONFIGURED_ORDER_VOLUME = 10000.0
POSITION_TICKET_PATTERN = re.compile(r'^\d{1,20}$')
STRATEGY_MAGIC = 420003
PEPPERSTONE_SERVER_PREFIX = "pepperstoneuk-"
PEPPERSTONE_STANDARD_OFFSET_SECONDS = 2 * 60 * 60
PEPPERSTONE_DAYLIGHT_OFFSET_SECONDS = 3 * 60 * 60
output_lock = threading.Lock()
tick_streams = {}
tick_streams_lock = threading.Lock()

TIMEFRAMES = {
    "M1": "TIMEFRAME_M1",
    "M2": "TIMEFRAME_M2",
    "M3": "TIMEFRAME_M3",
    "M4": "TIMEFRAME_M4",
    "M5": "TIMEFRAME_M5",
    "M6": "TIMEFRAME_M6",
    "M10": "TIMEFRAME_M10",
    "M12": "TIMEFRAME_M12",
    "M15": "TIMEFRAME_M15",
    "M20": "TIMEFRAME_M20",
    "M30": "TIMEFRAME_M30",
    "H1": "TIMEFRAME_H1",
    "H2": "TIMEFRAME_H2",
    "H3": "TIMEFRAME_H3",
    "H4": "TIMEFRAME_H4",
    "H6": "TIMEFRAME_H6",
    "H8": "TIMEFRAME_H8",
    "H12": "TIMEFRAME_H12",
    "D1": "TIMEFRAME_D1",
    "W1": "TIMEFRAME_W1",
    "MN1": "TIMEFRAME_MN1",
}


def require_mt5():
    if mt5 is None:
        raise RuntimeError(
            "The MetaTrader5 Python package is not installed for this Python. "
            "Install 64-bit Python 3.10–3.14, then run: python -m pip install MetaTrader5"
        )


def require_connected_terminal():
    require_mt5()
    terminal = mt5.terminal_info()
    if terminal is None or not terminal.connected:
        raise RuntimeError("MetaTrader is not connected. Connect to a broker in the MT5 Feed panel first.")


def pepperstone_us_dst_bounds_utc(year):
    """Return the post-2007 US DST boundaries used by the verified PepperstoneUK server clock."""
    if year < 2007:
        raise RuntimeError(
            f"PepperstoneUK timestamp conversion is only verified for 2007 and later (received {year})."
        )

    def nth_sunday(month, occurrence):
        first_weekday = datetime.date(year, month, 1).weekday()
        first_sunday = 1 + (6 - first_weekday) % 7
        return first_sunday + (occurrence - 1) * 7

    start = datetime.datetime(
        year, 3, nth_sunday(3, 2), 7, tzinfo=datetime.timezone.utc
    )
    end = datetime.datetime(
        year, 11, nth_sunday(11, 1), 6, tzinfo=datetime.timezone.utc
    )
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def pepperstone_offset_at_utc(utc_time_msc):
    year = datetime.datetime.fromtimestamp(
        utc_time_msc / 1000, datetime.timezone.utc
    ).year
    dst_start, dst_end = pepperstone_us_dst_bounds_utc(year)
    if dst_start <= utc_time_msc < dst_end:
        return PEPPERSTONE_DAYLIGHT_OFFSET_SECONDS
    return PEPPERSTONE_STANDARD_OFFSET_SECONDS


def mt5_current_server_name():
    account = mt5.account_info()
    return getattr(account, "server", "") if account is not None else ""


def mt5_uses_pepperstone_server_time(server=None):
    if server is None:
        server = mt5_current_server_name()
    return isinstance(server, str) and server.lower().startswith(PEPPERSTONE_SERVER_PREFIX)


_server_offsets = {}


def mt5_detected_server_offset_seconds(server=None):
    server = server if server is not None else mt5_current_server_name()
    now = time.time()
    cached = _server_offsets.get(server)
    if cached and now - cached[1] < 60:
        return cached[0]
    if mt5 is not None:
        for symbol in ("EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "US30"):
            tick = mt5.symbol_info_tick(symbol)
            raw_time = getattr(tick, "time", 0) if tick is not None else 0
            if raw_time <= 0:
                continue
            diff = raw_time - now
            offset = round(diff / 1800) * 1800
            if abs(offset) <= 14 * 3600 and -30 <= offset - diff <= 90:
                _server_offsets[server] = (offset, now)
                return offset
    # Slow or closed instruments cannot establish a UTC offset.
    return cached[0] if cached else 0


def mt5_utc_to_server_time_msc(utc_time_msc, server=None):
    if mt5_uses_pepperstone_server_time(server):
        return int(utc_time_msc) + pepperstone_offset_at_utc(int(utc_time_msc)) * 1000
    offset_sec = mt5_detected_server_offset_seconds(server)
    return int(utc_time_msc) + offset_sec * 1000


def mt5_server_to_utc_time_msc(server_time_msc, server=None, previous_utc_msc=None, reference_utc_msc=None, prefer_past=False):
    server_time_msc = int(server_time_msc)
    if mt5_uses_pepperstone_server_time(server):
        candidates = []
        for offset in (PEPPERSTONE_STANDARD_OFFSET_SECONDS, PEPPERSTONE_DAYLIGHT_OFFSET_SECONDS):
            utc_time_msc = server_time_msc - offset * 1000
            if pepperstone_offset_at_utc(utc_time_msc) == offset:
                candidates.append(utc_time_msc)
        if candidates:
            if previous_utc_msc is not None:
                monotonic_candidates = [candidate for candidate in candidates if candidate >= previous_utc_msc]
                if monotonic_candidates:
                    candidates = monotonic_candidates
            elif reference_utc_msc is not None:
                if prefer_past:
                    matching = [candidate for candidate in candidates if candidate <= reference_utc_msc + 1000]
                else:
                    matching = [candidate for candidate in candidates if candidate >= reference_utc_msc]
                if matching:
                    candidates = matching
            if reference_utc_msc is not None:
                return min(candidates, key=lambda candidate: abs(candidate - reference_utc_msc))
            return min(candidates)

    offset_sec = mt5_detected_server_offset_seconds(server)
    return server_time_msc - offset_sec * 1000


def normalize_mt5_server_timestamps(raw_times_msc, server=None, anchor_utc_msc=None, reference_utc_msc=None):
    if server is None:
        server = mt5_current_server_name()
    normalized = []
    previous_utc_msc = None
    for raw_time_msc in raw_times_msc:
        utc_time_msc = mt5_server_to_utc_time_msc(
            raw_time_msc,
            server,
            previous_utc_msc=previous_utc_msc,
            reference_utc_msc=reference_utc_msc if previous_utc_msc is None else None,
        )
        if previous_utc_msc is None and anchor_utc_msc is not None and utc_time_msc < anchor_utc_msc:
            candidates = [
                mt5_server_to_utc_time_msc(raw_time_msc, server, reference_utc_msc=anchor_utc_msc),
            ]
            utc_time_msc = candidates[0]
        normalized.append(utc_time_msc)
        previous_utc_msc = utc_time_msc
    return normalized


class BridgeOperationError(RuntimeError):
    def __init__(self, message, phase="pre-send"):
        super().__init__(message)
        self.phase = phase


def get_trading_status():
    require_connected_terminal()
    terminal = mt5.terminal_info()
    account = mt5.account_info()
    if account is None:
        raise BridgeOperationError("MetaTrader has no logged-in trading account.")
    trade_mode = int(getattr(account, "trade_mode", -1))
    if trade_mode == getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0):
        account_mode = "demo"
    elif trade_mode == getattr(mt5, "ACCOUNT_TRADE_MODE_CONTEST", 1):
        account_mode = "contest"
    elif trade_mode == getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2):
        account_mode = "real"
    else:
        account_mode = "unknown"
    return {
        "connected": True,
        "tradingAllowed": bool(getattr(terminal, "trade_allowed", False) and getattr(account, "trade_allowed", False)),
        "terminalTradingAllowed": bool(getattr(terminal, "trade_allowed", False)),
        "accountTradingAllowed": bool(getattr(account, "trade_allowed", False)),
        "accountMode": account_mode,
        "accountLogin": str(getattr(account, "login", "") or ""),
        "server": str(getattr(account, "server", "") or ""),
        "currency": str(getattr(account, "currency", "") or ""),
        "equity": float(getattr(account, "equity", 0) or 0),
    }


def _finite_positive(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise BridgeOperationError(f"Enter a valid positive {label}.")
    return float(value)


def _trusted_order_volume_limit(request):
    value = request.get("maxOrderVolume", os.environ.get("OMEGA_MT5_MAX_ORDER_VOLUME", DEFAULT_MAX_ORDER_VOLUME))
    try:
        maximum = float(value)
    except (TypeError, ValueError):
        maximum = math.nan
    if isinstance(value, bool) or not math.isfinite(maximum) or maximum <= 0 or maximum > MAX_CONFIGURED_ORDER_VOLUME:
        raise BridgeOperationError(
            f"The trusted MT5 order-volume safeguard is invalid; it must be positive and no greater than {MAX_CONFIGURED_ORDER_VOLUME:g} lots."
        )
    return maximum


def _assert_trusted_account(status, expected_account, context=""):
    if not isinstance(expected_account, dict):
        raise BridgeOperationError("A trusted MT5 account identity is required for live order submission.")
    expected_login = str(expected_account.get("login", "")).strip()
    expected_server = str(expected_account.get("server", "")).strip()
    actual_login = str(status.get("accountLogin", "")).strip()
    actual_server = str(status.get("server", "")).strip()
    if not expected_login or not expected_server or not actual_login or not actual_server:
        raise BridgeOperationError("A trusted MT5 account identity is required for live order submission.")
    if expected_login != actual_login or expected_server != actual_server:
        suffix = f" {context}" if context else ""
        raise BridgeOperationError(f"The signed-in MT5 account or server changed{suffix}; refusing the order.")


def _is_on_tick(price, tick_size):
    units = price / tick_size
    return math.isfinite(units) and abs(units - round(units)) <= 1e-6


def _serialize_order_result(result, status):
    if result is None:
        return {
            "status": "unknown",
            "retcode": None,
            "comment": "MetaTrader returned no result after order_send; check the terminal before retrying.",
        }
    return {
        "status": status,
        "retcode": int(getattr(result, "retcode", -1)),
        "order": int(getattr(result, "order", 0) or 0),
        "position": int(getattr(result, "order", 0) or 0),
        "deal": int(getattr(result, "deal", 0) or 0),
        "volume": float(getattr(result, "volume", 0) or 0),
        "price": float(getattr(result, "price", 0) or 0),
        "comment": str(getattr(result, "comment", "") or ""),
        "requestId": int(getattr(result, "request_id", 0) or 0),
        "externalRetcode": int(getattr(result, "retcode_external", 0) or 0),
    }


def _serialize_position_position(position):
    position_type = int(getattr(position, "type", -1))
    buy_type = getattr(mt5, "POSITION_TYPE_BUY", 0)
    return {
        "ticket": str(getattr(position, "ticket", "")),
        "symbol": str(getattr(position, "symbol", "") or ""),
        "volume": float(getattr(position, "volume", 0) or 0),
        "priceOpen": float(getattr(position, "price_open", 0) or 0),
        "side": "BUY" if position_type == buy_type else "SELL",
        "profit": float(getattr(position, "profit", 0) or 0),
    }


def verify_live_provenance(request):
    """Verify that a strategy intent maps to a confirmed, fresh live MT5 event.

    History, forming-bar, replay, visual-backtest, and paper sources are refused.
    """
    status = get_trading_status()
    if not status["tradingAllowed"]:
        raise BridgeOperationError("MetaTrader must permit trading before live strategy provenance can be verified.")
    if not isinstance(request, dict):
        raise BridgeOperationError("Invalid live provenance request.")
    provenance = request.get("provenance")
    if not isinstance(provenance, dict):
        raise BridgeOperationError("A confirmed live provenance record is required.")
    if (provenance.get("environment") != "live"
            or provenance.get("signalState") != "confirmed"
            or provenance.get("marketData") != "live"
            or provenance.get("backtest") is True
            or provenance.get("paper") is True):
        raise BridgeOperationError("Only confirmed live provider events are eligible for live strategy trading.")
    if provenance.get("replay") is True:
        raise BridgeOperationError("Replay signals are not eligible for live strategy trading.")
    event_id = str(provenance.get("providerEventId", "")).strip()
    if not event_id or len(event_id) > 200:
        raise BridgeOperationError("A confirmed live provider event id is required.")
    emitted_at = request.get("emittedAt")
    if not isinstance(emitted_at, (int, float)) or isinstance(emitted_at, bool) or not math.isfinite(emitted_at) or emitted_at <= 0:
        raise BridgeOperationError("A valid intent emission time is required.")
    now_ms = int(time.time() * 1000)
    if now_ms - int(emitted_at) > MAX_INTENT_AGE_MS:
        raise BridgeOperationError("The strategy intent is stale; re-emit a fresh live signal.")
    symbol = str(request.get("symbol", "")).strip()
    if not symbol or len(symbol) > 100:
        raise BridgeOperationError("A valid MetaTrader symbol is required.")
    if mt5.symbol_info(symbol) is None:
        raise BridgeOperationError(f"MetaTrader does not recognize symbol {symbol}.")
    if not mt5.symbol_select(symbol, True):
        raise BridgeOperationError(f"Could not select {symbol} in MetaTrader: {mt5.last_error()}")
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise BridgeOperationError(f"Could not read a fresh tick for {symbol} from MetaTrader: {mt5.last_error()}")
    bid = float(tick.bid)
    ask = float(tick.ask)
    if not math.isfinite(bid) or not math.isfinite(ask) or bid <= 0 or ask < bid:
        raise BridgeOperationError(f"MetaTrader returned an invalid bid/ask tick for {symbol}.")
    return {"verified": True, "eventId": event_id, "symbol": symbol, "bid": bid, "ask": ask}


def validate_protection(request):
    """Validate stop-loss/take-profit against a fresh executable quote."""
    status = get_trading_status()
    if not status["tradingAllowed"]:
        raise BridgeOperationError("MetaTrader must permit trading before strategy protection can be validated.")
    if not isinstance(request, dict):
        raise BridgeOperationError("Invalid protection validation request.")
    symbol = str(request.get("symbol", "")).strip()
    if not symbol or len(symbol) > 100:
        raise BridgeOperationError("A valid MetaTrader symbol is required.")
    side = str(request.get("side", "")).strip().upper()
    if side not in ("BUY", "SELL"):
        raise BridgeOperationError("Order side must be BUY or SELL.")
    stop_loss = None
    if request.get("stopLoss") not in (None, ""):
        stop_loss = _finite_positive(request.get("stopLoss"), "stop-loss price")
    take_profit = request.get("takeProfit")
    take_profit = _finite_positive(take_profit, "take-profit price") if take_profit is not None else None
    info = mt5.symbol_info(symbol)
    if info is None:
        raise BridgeOperationError(f"MetaTrader does not recognize symbol {symbol}.")
    if not mt5.symbol_select(symbol, True):
        raise BridgeOperationError(f"Could not select {symbol} in MetaTrader: {mt5.last_error()}")
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise BridgeOperationError(f"Could not read a fresh tick for {symbol} from MetaTrader: {mt5.last_error()}")
    bid = float(tick.bid)
    ask = float(tick.ask)
    digits = int(getattr(info, "digits", 5) or 5)
    point = float(getattr(info, "point", 0.00001) or 0.00001)
    trade_stops_level = float(getattr(info, "trade_stops_level", 0) or 0)
    minimum_distance = max(trade_stops_level * point, point)
    if side == "BUY":
        if stop_loss is not None and stop_loss >= bid - minimum_distance:
            raise BridgeOperationError(f"BUY stop-loss for {symbol} must be below the current bid by at least {minimum_distance}.")
        if take_profit is not None and take_profit <= bid + minimum_distance:
            raise BridgeOperationError(f"BUY take-profit for {symbol} must be above the current bid by at least {minimum_distance}.")
    else:
        if stop_loss is not None and stop_loss <= ask + minimum_distance:
            raise BridgeOperationError(f"SELL stop-loss for {symbol} must be above the current ask by at least {minimum_distance}.")
        if take_profit is not None and take_profit >= ask - minimum_distance:
            raise BridgeOperationError(f"SELL take-profit for {symbol} must be below the current ask by at least {minimum_distance}.")
    tick_size = float(getattr(info, "trade_tick_size", point) or point)
    if stop_loss is not None:
        stop_loss = round(round(stop_loss / tick_size) * tick_size, digits)
    if take_profit is not None:
        take_profit = round(round(take_profit / tick_size) * tick_size, digits)
    return {"valid": True, "symbol": symbol, "side": side, "bid": bid, "ask": ask, "stopLoss": stop_loss, "takeProfit": take_profit}


def place_market_order(request):
    status = get_trading_status()
    if not status["tradingAllowed"]:
        if not status["terminalTradingAllowed"]:
            raise BridgeOperationError("MetaTrader terminal does not permit algorithmic trading. Enable trading in the terminal and retry.")
        raise BridgeOperationError("The logged-in MetaTrader account does not permit trading.")
    if not isinstance(request, dict):
        raise BridgeOperationError("Invalid MetaTrader order request.")
    expected_account = request.get("expectedAccount")
    _assert_trusted_account(status, expected_account)
    max_order_volume = _trusted_order_volume_limit(request)
    symbol_name = request.get("symbol")
    symbol = symbol_name.strip() if isinstance(symbol_name, str) else ""
    if not symbol or len(symbol) > 100:
        raise BridgeOperationError("Enter a valid MetaTrader symbol.")
    side = request.get("side")
    if not isinstance(side, str) or side.strip().upper() not in ("BUY", "SELL"):
        raise BridgeOperationError("Order side must be BUY or SELL.")
    side = side.strip().upper()
    volume = _finite_positive(request.get("volume"), "order volume")
    if volume > max_order_volume:
        raise BridgeOperationError(f"Order volume exceeds the configured {max_order_volume:g}-lot live-order limit.")
    stop_loss = None
    if request.get("stopLoss") not in (None, ""):
        stop_loss = _finite_positive(request.get("stopLoss"), "stop-loss price")
    if stop_loss is None:
        raise BridgeOperationError("A stop-loss is required for every MT5 live order.")
    take_profit = None
    if request.get("takeProfit") is not None:
        take_profit = _finite_positive(request.get("takeProfit"), "take-profit price")

    info = mt5.symbol_info(symbol)
    if info is None:
        raise BridgeOperationError(f"MetaTrader does not recognize symbol {symbol}.")
    if not mt5.symbol_select(symbol, True):
        raise BridgeOperationError(f"Could not select {symbol} in MetaTrader: {mt5.last_error()}")
    trade_mode = int(getattr(info, "trade_mode", getattr(mt5, "SYMBOL_TRADE_MODE_DISABLED", 0)))
    permitted_modes = {
        "BUY": {
            getattr(mt5, "SYMBOL_TRADE_MODE_FULL", 4),
            getattr(mt5, "SYMBOL_TRADE_MODE_LONGONLY", 1),
        },
        "SELL": {
            getattr(mt5, "SYMBOL_TRADE_MODE_FULL", 4),
            getattr(mt5, "SYMBOL_TRADE_MODE_SHORTONLY", 2),
        },
    }
    if trade_mode not in permitted_modes[side]:
        raise BridgeOperationError(f"MetaTrader symbol {symbol} does not allow {side} orders.")

    volume_min = _finite_positive(getattr(info, "volume_min", None), "minimum symbol volume")
    volume_max = _finite_positive(getattr(info, "volume_max", None), "maximum symbol volume")
    volume_step = _finite_positive(getattr(info, "volume_step", None), "symbol volume step")
    if volume < volume_min or volume > volume_max:
        raise BridgeOperationError(f"Order volume for {symbol} must be between {volume_min} and {volume_max} lots.")
    volume_steps = (volume - volume_min) / volume_step
    if abs(volume_steps - round(volume_steps)) > 1e-7:
        raise BridgeOperationError(f"Order volume for {symbol} must use a {volume_step}-lot step.")

    point = _finite_positive(getattr(info, "point", None), "symbol point size")
    digits = int(getattr(info, "digits", 0))
    tick_size = _finite_positive(getattr(info, "trade_tick_size", None) or point, "symbol tick size")
    if not mt5.symbol_select(symbol, True):
        raise BridgeOperationError(f"Could not select {symbol} in MetaTrader: {mt5.last_error()}")
    bid, ask, quote_time_msc = latest_mt5_bid_ask(symbol)
    quote_age_ms = int(time.time() * 1000) - quote_time_msc
    if quote_age_ms < -MAX_ORDER_QUOTE_AGE_MS:
        clock_skew_seconds = round(abs(quote_age_ms) / 1000)
        raise BridgeOperationError(
            f"MetaTrader tick timestamp is {clock_skew_seconds} seconds ahead of the system clock; "
            "refusing the order until the feed timestamp basis is corrected."
        )
    if quote_age_ms > MAX_ORDER_QUOTE_AGE_MS:
        quote_age_seconds = round(quote_age_ms / 1000)
        raise BridgeOperationError(
            f"MetaTrader returned a stale quote for {symbol}; its last tick is {quote_age_seconds} seconds old. "
            "Check that the market is open, the symbol is visible in Market Watch, and MT5 is receiving live ticks."
        )

    stops_level = max(0, int(getattr(info, "trade_stops_level", 0) or 0))
    minimum_distance = stops_level * point
    reference_price = bid if side == "BUY" else ask
    if side == "BUY":
        if stop_loss is not None and stop_loss >= reference_price - minimum_distance:
            raise BridgeOperationError(f"BUY stop-loss for {symbol} must be below the current bid by at least {minimum_distance}.")
        if take_profit is not None and take_profit <= reference_price + minimum_distance:
            raise BridgeOperationError(f"BUY take-profit for {symbol} must be above the current bid by at least {minimum_distance}.")
    else:
        if stop_loss is not None and stop_loss <= reference_price + minimum_distance:
            raise BridgeOperationError(f"SELL stop-loss for {symbol} must be above the current ask by at least {minimum_distance}.")
        if take_profit is not None and take_profit >= reference_price - minimum_distance:
            raise BridgeOperationError(f"SELL take-profit for {symbol} must be below the current ask by at least {minimum_distance}.")
    if stop_loss is not None:
        stop_loss = round(round(stop_loss / tick_size) * tick_size, digits)
    if take_profit is not None:
        take_profit = round(round(take_profit / tick_size) * tick_size, digits)

    filling_flags = int(getattr(info, "filling_mode", 0) or 0)
    if filling_flags & getattr(mt5, "SYMBOL_FILLING_FOK", 1):
        filling = getattr(mt5, "ORDER_FILLING_FOK", 0)
    elif filling_flags & getattr(mt5, "SYMBOL_FILLING_IOC", 2):
        filling = getattr(mt5, "ORDER_FILLING_IOC", 1)
    else:
        filling = getattr(mt5, "ORDER_FILLING_RETURN", 2)
    order_type = getattr(mt5, "ORDER_TYPE_BUY" if side == "BUY" else "ORDER_TYPE_SELL")
    order = {
        "action": getattr(mt5, "TRADE_ACTION_DEAL"),
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": ask if side == "BUY" else bid,
        "sl": round(stop_loss, digits) if stop_loss is not None else 0.0,
        "tp": round(take_profit, digits) if take_profit is not None else 0.0,
        "deviation": 20,
        "magic": 420002,
        "comment": "Omega live order",
        "type_time": getattr(mt5, "ORDER_TIME_GTC", 0),
        "type_filling": filling,
    }

    try:
        check = mt5.order_check(order)
    except Exception as error:
        raise BridgeOperationError(f"MetaTrader order pre-check failed: {error}") from error
    if check is None:
        raise BridgeOperationError(f"MetaTrader order pre-check returned no result: {mt5.last_error()}")
    check_retcode = int(getattr(check, "retcode", -1))
    if check_retcode not in (0, getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
        raise BridgeOperationError(
            f"MetaTrader rejected the order pre-check ({check_retcode}): {getattr(check, 'comment', '') or mt5.last_error()}"
        )

    latest_status = get_trading_status()
    if not latest_status["tradingAllowed"]:
        raise BridgeOperationError("MetaTrader no longer permits trading.")
    _assert_trusted_account(latest_status, expected_account, "during pre-check")

    try:
        result = mt5.order_send(order)
    except Exception as error:
        raise BridgeOperationError(
            f"MetaTrader order_send failed after submission may have started: {error}",
            phase="send-unknown",
        ) from error
    if result is None:
        return _serialize_order_result(None, "unknown")
    retcode = int(getattr(result, "retcode", -1))
    if retcode == getattr(mt5, "TRADE_RETCODE_DONE", 10009):
        result_status = "filled"
    elif retcode == getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010):
        result_status = "partial"
    elif retcode == getattr(mt5, "TRADE_RETCODE_PLACED", 10008):
        result_status = "placed"
    else:
        result_status = "rejected"
    return _serialize_order_result(result, result_status)


def get_position(request):
    """Get a position by exact broker ticket."""
    status = get_trading_status()
    if not status["tradingAllowed"]:
        raise BridgeOperationError("MetaTrader must permit trading before position lookup.")
    if not isinstance(request, dict):
        raise BridgeOperationError("Invalid position lookup request.")
    ticket = str(request.get("positionTicket", "")).strip()
    if not POSITION_TICKET_PATTERN.match(ticket):
        raise BridgeOperationError("A valid broker position ticket is required.")
    positions = mt5.positions_get(ticket=int(ticket))
    if positions is None:
        raise BridgeOperationError(f"Could not read position {ticket} from MetaTrader: {mt5.last_error()}")
    if len(positions) == 0:
        return None
    return _serialize_position_position(positions[0])


def open_position(request):
    """Open a protected strategy position. Reuses the live order pre-check/send path."""
    if not isinstance(request, dict):
        raise BridgeOperationError("Invalid position open request.")
    order_request = {
        "symbol": request.get("symbol"),
        "side": request.get("side"),
        "volume": request.get("volume"),
        "stopLoss": request.get("stopLoss"),
        "takeProfit": request.get("takeProfit"),
        "expectedAccount": request.get("expectedAccount"),
        "maxOrderVolume": request.get("maxOrderVolume", DEFAULT_MAX_ORDER_VOLUME),
    }
    result = place_market_order(order_request)
    return {
        "status": result.get("status", "unknown"),
        "positionTicket": str(result.get("order", "")) or str(result.get("deal", "")),
        "orderTicket": str(result.get("order", "")),
        "dealTicket": str(result.get("deal", "")),
        "filledVolume": float(result.get("volume", 0) or 0),
        "price": float(result.get("price", 0) or 0),
        "retcode": result.get("retcode"),
        "comment": result.get("comment", ""),
    }


def close_position(request):
    """Close a position by exact broker ticket."""
    status = get_trading_status()
    if not status["tradingAllowed"]:
        raise BridgeOperationError("MetaTrader must permit trading before position close.")
    if not isinstance(request, dict):
        raise BridgeOperationError("Invalid position close request.")
    expected_account = request.get("expectedAccount")
    _assert_trusted_account(status, expected_account)
    ticket = str(request.get("positionTicket", "")).strip()
    if not POSITION_TICKET_PATTERN.match(ticket):
        raise BridgeOperationError("A valid broker position ticket is required.")
    volume = _finite_positive(request.get("volume"), "close volume")
    symbol = str(request.get("symbol", "")).strip()
    if not symbol or len(symbol) > 100:
        raise BridgeOperationError("A valid MetaTrader symbol is required.")
    side = str(request.get("side", "")).strip().upper()
    if side not in ("BUY", "SELL"):
        raise BridgeOperationError("Order side must be BUY or SELL.")
    close_type = getattr(mt5, "ORDER_TYPE_SELL" if side == "BUY" else "ORDER_TYPE_BUY")
    price_source = "bid" if side == "BUY" else "ask"
    info = mt5.symbol_info(symbol)
    if info is None:
        raise BridgeOperationError(f"MetaTrader does not recognize symbol {symbol}.")
    if not mt5.symbol_select(symbol, True):
        raise BridgeOperationError(f"Could not select {symbol} in MetaTrader: {mt5.last_error()}")
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise BridgeOperationError(f"Could not read a fresh tick for {symbol} from MetaTrader: {mt5.last_error()}")
    price = float(tick.bid) if price_source == "bid" else float(tick.ask)
    digits = int(getattr(info, "digits", 5) or 5)
    filling_flags = int(getattr(info, "filling_mode", 0) or 0)
    if filling_flags & getattr(mt5, "SYMBOL_FILLING_FOK", 1):
        filling = getattr(mt5, "ORDER_FILLING_FOK", 0)
    elif filling_flags & getattr(mt5, "SYMBOL_FILLING_IOC", 2):
        filling = getattr(mt5, "ORDER_FILLING_IOC", 1)
    else:
        filling = getattr(mt5, "ORDER_FILLING_RETURN", 2)
    order = {
        "action": getattr(mt5, "TRADE_ACTION_DEAL"),
        "symbol": symbol,
        "volume": volume,
        "type": close_type,
        "position": int(ticket),
        "price": round(price, digits),
        "deviation": 20,
        "magic": STRATEGY_MAGIC,
        "comment": "Omega strategy close",
        "type_time": getattr(mt5, "ORDER_TIME_GTC", 0),
        "type_filling": filling,
    }
    try:
        check = mt5.order_check(order)
    except Exception as error:
        raise BridgeOperationError(f"MetaTrader close pre-check failed: {error}") from error
    if check is None:
        raise BridgeOperationError(f"MetaTrader close pre-check returned no result: {mt5.last_error()}")
    check_retcode = int(getattr(check, "retcode", -1))
    if check_retcode not in (0, getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
        raise BridgeOperationError(
            f"MetaTrader rejected the close pre-check ({check_retcode}): {getattr(check, 'comment', '') or mt5.last_error()}"
        )
    latest_status = get_trading_status()
    if not latest_status["tradingAllowed"]:
        raise BridgeOperationError("MetaTrader no longer permits trading.")
    _assert_trusted_account(latest_status, expected_account, "during pre-check")
    try:
        result = mt5.order_send(order)
    except Exception as error:
        raise BridgeOperationError(
            f"MetaTrader close_send failed after submission may have started: {error}",
            phase="send-unknown",
        ) from error
    if result is None:
        return {"status": "unknown", "positionTicket": ticket}
    retcode = int(getattr(result, "retcode", -1))
    if retcode == getattr(mt5, "TRADE_RETCODE_DONE", 10009):
        result_status = "filled"
    elif retcode == getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010):
        result_status = "partial"
    elif retcode == getattr(mt5, "TRADE_RETCODE_PLACED", 10008):
        result_status = "placed"
    else:
        result_status = "rejected"
    return {
        "status": result_status,
        "positionTicket": ticket,
        "retcode": retcode,
        "order": int(getattr(result, "order", 0) or 0),
        "deal": int(getattr(result, "deal", 0) or 0),
        "volume": float(getattr(result, "volume", 0) or 0),
        "price": float(getattr(result, "price", 0) or 0),
        "comment": str(getattr(result, "comment", "") or ""),
    }


def reconcile_intent(request):
    """Reconcile an uncertain strategy intent against broker position state."""
    status = get_trading_status()
    if not status["tradingAllowed"]:
        raise BridgeOperationError("MetaTrader must permit trading before reconciliation.")
    if not isinstance(request, dict):
        raise BridgeOperationError("Invalid reconciliation request.")
    intent_id = str(request.get("intentId", "")).strip()
    action = str(request.get("action", "")).strip()
    account = request.get("account")
    if not isinstance(account, dict):
        raise BridgeOperationError("An MT5 account identity is required for reconciliation.")
    expected_login = str(account.get("login", "")).strip()
    expected_server = str(account.get("server", "")).strip()
    if not expected_login or not expected_server:
        raise BridgeOperationError("An MT5 account identity is required for reconciliation.")
    actual_login = str(status.get("accountLogin", "")).strip()
    actual_server = str(status.get("server", "")).strip()
    if actual_login != expected_login or actual_server != expected_server:
        raise BridgeOperationError("The signed-in MT5 account or server changed. Reconciliation is blocked.")
    position_ticket = str(request.get("positionTicket", "")).strip() if request.get("positionTicket") else ""
    confirmed = False
    result_status = "unknown"
    position_ticket_out = position_ticket or None
    filled_volume = 0.0
    if action == "open" and position_ticket:
        if not POSITION_TICKET_PATTERN.match(position_ticket):
            return {"confirmed": False, "status": "unknown", "positionTicket": position_ticket_out, "filledVolume": 0.0, "intentId": intent_id}
        positions = mt5.positions_get(ticket=int(position_ticket))
        if positions is None:
            raise BridgeOperationError(f"Could not read position {position_ticket} from MetaTrader: {mt5.last_error()}")
        if len(positions) > 0:
            pos = positions[0]
            confirmed = True
            result_status = "filled"
            filled_volume = float(pos.volume)
    elif action in ("close", "reverse") and position_ticket:
        if not POSITION_TICKET_PATTERN.match(position_ticket):
            return {"confirmed": False, "status": "unknown", "positionTicket": position_ticket_out, "filledVolume": 0.0, "intentId": intent_id}
        positions = mt5.positions_get(ticket=int(position_ticket))
        if positions is None:
            raise BridgeOperationError(f"Could not read position {position_ticket} from MetaTrader: {mt5.last_error()}")
        if len(positions) == 0:
            confirmed = True
            result_status = "closed-flat"
    return {
        "confirmed": confirmed,
        "status": result_status,
        "positionTicket": position_ticket_out,
        "filledVolume": filled_volume,
        "intentId": intent_id,
    }


TERMINAL_EXE = "terminal64.exe"
TERMINAL_START_TIMEOUT_SECONDS = 90


def _running_terminal_paths():
    """Paths of terminal64.exe processes that are already running.

    Discovery must never abort the whole connection attempt: if the process
    lookup fails we simply fall back to scanning the installed terminals.
    """
    if sys.platform != "win32":
        return []
    command = (
        "Get-Process -Name terminal64 -ErrorAction SilentlyContinue "
        "| Where-Object { $_.Path } "
        "| Select-Object -ExpandProperty Path -Unique"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _registry_terminal_paths():
    try:
        import winreg
    except ImportError:
        return []
    found = []
    locations = (
        (winreg.HKEY_CURRENT_USER, r"Software\MetaQuotes\Terminal"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\MetaQuotes\Terminal"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\MetaQuotes\Terminal"),
    )
    for hive, subkey in locations:
        try:
            root = winreg.OpenKey(hive, subkey)
        except OSError:
            continue
        try:
            index = 0
            while True:
                try:
                    name = winreg.EnumKey(root, index)
                except OSError:
                    break
                index += 1
                try:
                    key = winreg.OpenKey(root, name)
                except OSError:
                    continue
                try:
                    directory, _ = winreg.QueryValueEx(key, "Path")
                except OSError:
                    directory = None
                finally:
                    key.Close()
                if isinstance(directory, str) and directory:
                    candidate = os.path.join(directory, TERMINAL_EXE)
                    if os.path.isfile(candidate):
                        found.append(candidate)
        finally:
            root.Close()
    return found


def _filesystem_terminal_paths():
    roots = (
        os.environ.get("ProgramW6432"),
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("LOCALAPPDATA"),
    )
    found = []
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for pattern in (f"*MetaTrader*/{TERMINAL_EXE}", f"*MetaTrader*/*/{TERMINAL_EXE}", f"*/{TERMINAL_EXE}"):
            try:
                found.extend(glob.glob(os.path.join(root, pattern)))
            except OSError:
                continue
    return found


def find_installed_terminal():
    """The best guess for an installed MetaTrader 5 terminal executable."""
    explicit = os.environ.get("OMEGA_MT5_TERMINAL", "").strip()
    candidates = ([explicit] if explicit else []) + _registry_terminal_paths() + _filesystem_terminal_paths()
    seen = set()
    for candidate in candidates:
        normalised = os.path.normcase(os.path.abspath(candidate))
        if normalised in seen:
            continue
        seen.add(normalised)
        if os.path.isfile(candidate):
            return candidate
    return None


def launch_terminal(terminal_path):
    """Start the terminal for the operator, detached from the JSON bridge pipes.

    The child must not inherit this process' pipes or it would corrupt the
    request/response protocol on stdout.
    """
    subprocess.Popen(
        [terminal_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


def initialize_terminal():
    """Attach to a running terminal, or start the installed one automatically."""
    for running in _running_terminal_paths():
        if mt5.initialize(path=running, timeout=60_000):
            return running

    installed = find_installed_terminal()
    if installed:
        # initialize(path=...) starts the terminal when it is not running yet.
        if mt5.initialize(path=installed, timeout=60_000):
            return installed
        try:
            launch_terminal(installed)
        except OSError as error:
            raise RuntimeError(f"Could not start MetaTrader 5 at {installed}: {error}") from error
        deadline = time.monotonic() + TERMINAL_START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            time.sleep(2)
            if mt5.initialize(path=installed, timeout=60_000):
                return installed
        raise RuntimeError(
            f"MetaTrader 5 was started from {installed} but did not answer within "
            f"{TERMINAL_START_TIMEOUT_SECONDS} seconds. Sign in to your broker account in the terminal and retry."
        )

    # No installed terminal was found: let the package use its own default.
    if mt5.initialize(timeout=60_000):
        return None
    raise RuntimeError(
        "No MetaTrader 5 terminal was found. Install MetaTrader 5, or set OMEGA_MT5_TERMINAL to the full path of "
        f"its {TERMINAL_EXE}, then retry. Last error: {mt5.last_error()}"
    )


def wait_for_connected_terminal(timeout_seconds=30):
    deadline = time.monotonic() + timeout_seconds
    while True:
        terminal = mt5.terminal_info()
        if terminal is not None and terminal.connected:
            return terminal
        if time.monotonic() >= deadline:
            return terminal
        time.sleep(1)


def serialize_symbols():
    symbols = mt5.symbols_get()
    if symbols is None:
        raise RuntimeError(f"Could not read MetaTrader symbols: {mt5.last_error()}")
    return [
        {
            "ticker": symbol.name,
            "description": symbol.description or symbol.name,
            "path": symbol.path or "",
            "digits": int(symbol.digits),
            "point": float(symbol.point),
            "tradeTickSize": float(getattr(symbol, "trade_tick_size", 0) or symbol.point),
            "currencyBase": symbol.currency_base or "",
            "currencyProfit": symbol.currency_profit or "",
            "tradeContractSize": float(getattr(symbol, "trade_contract_size", 0) or 0),
            "tickValue": float(getattr(symbol, "trade_tick_value", 0) or 0),
        }
        for symbol in symbols
        if symbol.name
    ]


def serialize_info(ticker):
    info = mt5.symbol_info(ticker)
    if info is None:
        return None
    return {
        "ticker": info.name,
        "description": info.description or info.name,
        "path": info.path or "",
        "digits": int(info.digits),
        "point": float(info.point),
        "tradeTickSize": float(getattr(info, "trade_tick_size", 0) or info.point),
        "currencyBase": info.currency_base or "",
        "currencyProfit": info.currency_profit or "",
        "tradeContractSize": float(getattr(info, "trade_contract_size", 0) or 0),
        "tickValue": float(getattr(info, "trade_tick_value", 0) or 0),
    }


def serialize_bar(row, time_msc):
    def row_volume(field_names):
        for field_name in field_names:
            try:
                value = float(row[field_name])
            except (KeyError, IndexError, TypeError, ValueError):
                continue
            if value > 0:
                return value
        return 0.0

    volume = row_volume(("real_volume", "tick_volume", "volume"))
    return {
        "time": int(time_msc),
        "open": float(row["open"]),
        "high": float(row["high"]),
        "low": float(row["low"]),
        "close": float(row["close"]),
        "volume": volume,
    }


def serialize_bars(rows, server=None, anchor_utc_msc=None):
    if server is None:
        server = mt5_current_server_name()
    raw_times_msc = [int(row["time"]) * 1000 for row in rows]
    normalized_times_msc = normalize_mt5_server_timestamps(
        raw_times_msc,
        server,
        anchor_utc_msc=anchor_utc_msc,
    )
    return [
        serialize_bar(row, time_msc)
        for row, time_msc in zip(rows, normalized_times_msc)
    ]


def load_bars_from_position(ticker, timeframe, limit, end_time=None):
    """Load up to `limit` bars, in pages.

    copy_rates_from_pos refuses a very large count outright: asking for 50 000 bars returns
    (-2, 'Terminal: Invalid params') in about a millisecond, while 500 or 1000 work. Paging
    keeps every requested size working, and stops early when the terminal runs out of history.
    """
    bars = []
    position = 0
    while len(bars) < limit:
        take = min(MAX_RATES_PER_CALL, limit - len(bars))
        if end_time is None:
            chunk = mt5.copy_rates_from_pos(ticker, timeframe, position, take)
        else:
            chunk = mt5.copy_rates_from(ticker, timeframe, end_time, take)
        if chunk is None:
            if not bars:
                raise RuntimeError(f"Could not load {ticker} history from MetaTrader: {mt5.last_error()}")
            break
        if len(chunk) == 0:
            break
        bars.extend(chunk)
        position += len(chunk)
        if len(chunk) < take:
            break
        if end_time is not None:
            oldest = min(int(row["time"]) for row in chunk)
            if oldest > end_time.timestamp():
                break
            end_time = datetime.datetime.fromtimestamp(oldest - 1, datetime.timezone.utc)
    return bars


def get_bars(request):
    ticker = request["ticker"]
    timeframe_name = request["timeframe"]
    timeframe = getattr(mt5, TIMEFRAMES.get(timeframe_name, ""), None)
    if timeframe is None:
        raise RuntimeError(f"MetaTrader does not support timeframe {timeframe_name}.")
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")

    server = mt5_current_server_name()
    range_value = request.get("range") or {}
    limit = min(max(int(range_value.get("limit", 1000)), 1), 50000)
    start = range_value.get("from")
    end = range_value.get("to")
    if start is not None:
        start_utc_msc = int(float(start))
        end_utc_msc = (
            int(float(end))
            if end is not None
            else int(time.time() * 1000)
        )
        start_time = datetime.datetime.fromtimestamp(
            mt5_utc_to_server_time_msc(start_utc_msc, server) / 1000,
            datetime.timezone.utc,
        )
        end_time = datetime.datetime.fromtimestamp(
            mt5_utc_to_server_time_msc(end_utc_msc, server) / 1000,
            datetime.timezone.utc,
        )
        rates = mt5.copy_rates_range(ticker, timeframe, start_time, end_time)
        if rates is None:
            raise RuntimeError(f"Could not load {ticker} history from MetaTrader: {mt5.last_error()}")
        bars = serialize_bars(rates, server, anchor_utc_msc=start_utc_msc)
    elif end is not None:
        end_utc_msc = int(float(end))
        end_time = datetime.datetime.fromtimestamp(
            mt5_utc_to_server_time_msc(end_utc_msc, server) / 1000,
            datetime.timezone.utc,
        )
        rates = load_bars_from_position(ticker, timeframe, limit, end_time)
        rates.sort(key=lambda row: int(row["time"]))
        bars = [
            bar for bar in serialize_bars(rates, server, anchor_utc_msc=end_utc_msc)
            if bar["time"] <= end_utc_msc
        ]
    else:
        rates = load_bars_from_position(ticker, timeframe, limit)
        bars = serialize_bars(rates, server)

    bars.sort(key=lambda bar: bar["time"])
    return bars[-limit:]


def latest_mt5_bid_ask(symbol):
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise BridgeOperationError(f"Could not read the latest {symbol} tick from MetaTrader: {mt5.last_error()}")
    bid = float(tick.bid)
    ask = float(tick.ask)
    if not math.isfinite(bid) or not math.isfinite(ask) or bid <= 0 or ask < bid:
        raise BridgeOperationError(f"MetaTrader returned an invalid bid/ask tick for {symbol}.")
    raw_time = int(getattr(tick, "time_msc", 0) or 0)
    if raw_time <= 0:
        raise BridgeOperationError(f"MetaTrader did not provide a timestamped quote for {symbol}.")

    now = int(time.time() * 1000)
    oldest = now - MAX_ORDER_QUOTE_AGE_MS
    server = mt5_current_server_name()
    quote_time = mt5_server_to_utc_time_msc(raw_time, server, reference_utc_msc=now, prefer_past=True)
    if quote_time >= oldest:
        return bid, ask, quote_time

    # The terminal's symbol snapshot can lag behind ticks already in its database.
    start = datetime.datetime.fromtimestamp(mt5_utc_to_server_time_msc(oldest, server) / 1000, datetime.timezone.utc)
    ticks = mt5.copy_ticks_from(symbol, start, 1000, getattr(mt5, "COPY_TICKS_INFO", mt5.COPY_TICKS_ALL))
    if ticks is not None:
        for row in reversed(ticks):
            row_bid, row_ask = float(row["bid"]), float(row["ask"])
            if not math.isfinite(row_bid) or not math.isfinite(row_ask) or row_bid <= 0 or row_ask < row_bid:
                continue
            row_time = mt5_server_to_utc_time_msc(int(row["time_msc"]), server, reference_utc_msc=now, prefer_past=True)
            if oldest <= row_time <= now + 1000 and row_time > quote_time:
                return row_bid, row_ask, row_time
    return bid, ask, quote_time


def get_quote(request):
    require_connected_terminal()
    ticker_value = request.get("ticker")
    ticker = ticker_value.strip() if isinstance(ticker_value, str) else ""
    if not ticker or len(ticker) > 100:
        raise RuntimeError("Enter a valid MetaTrader symbol.")
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")
    bid, ask, utc_time_msc = latest_mt5_bid_ask(ticker)
    return {"bid": bid, "ask": ask, "timeMsc": utc_time_msc}


def get_ticks(request):
    require_connected_terminal()
    ticker_value = request.get("ticker")
    ticker = ticker_value.strip() if isinstance(ticker_value, str) else ""
    if not ticker or len(ticker) > 100:
        raise RuntimeError("Enter a valid MetaTrader symbol.")
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")

    from_msc = request.get("fromMsc")
    if not isinstance(from_msc, (int, float)) or not math.isfinite(from_msc) or from_msc < 0:
        raise RuntimeError("Enter a valid MetaTrader tick start time.")
    count = min(max(int(request.get("limit", 1000)), 1), 10000)
    server = mt5_current_server_name()
    start_server_msc = mt5_utc_to_server_time_msc(int(from_msc), server)
    start_time = datetime.datetime.fromtimestamp(start_server_msc / 1000, datetime.timezone.utc)
    ticks = mt5.copy_ticks_from(ticker, start_time, count, mt5.COPY_TICKS_ALL)
    if ticks is None:
        raise RuntimeError(f"Could not read live {ticker} ticks from MetaTrader: {mt5.last_error()}")
    normalized_times_msc = normalize_mt5_server_timestamps(
        [int(tick["time_msc"]) for tick in ticks],
        server,
        anchor_utc_msc=int(from_msc),
    )
    return [
        {
            "time": time_msc,
            "bid": float(tick["bid"]),
            "ask": float(tick["ask"]),
            "last": float(tick["last"]),
            "volume": float(tick["volume"]),
            "volumeReal": float(tick["volume_real"]),
            "flags": int(tick["flags"]),
        }
        for tick, time_msc in zip(ticks, normalized_times_msc)
    ]


def emit(payload):
    """Write one NDJSON message without interleaving bridge responses and stream events."""
    with output_lock:
        print(json.dumps(payload, separators=(",", ":")), flush=True)


def live_ticks_after_cursor(ticks, cursor, seen_at_cursor):
    """Drop pre-subscription and repeated inclusive-boundary ticks from a poll batch."""
    fresh = []
    batch_occurrences = {}
    for tick in ticks:
        tick_time = tick["time"]
        if tick_time < cursor:
            continue
        if tick_time > cursor:
            cursor = tick_time
            seen_at_cursor.clear()
            batch_occurrences.clear()
        key = tuple(tick.get(field) for field in ("bid", "ask", "last", "volume", "volumeReal", "flags"))
        occurrence = batch_occurrences.get(key, 0) + 1
        batch_occurrences[key] = occurrence
        if occurrence <= seen_at_cursor.get(key, 0):
            continue
        seen_at_cursor[key] = occurrence
        fresh.append(tick)
    return cursor, fresh


def _poll_ticks_raw(ticker, from_msc, count):
    """Fetch raw ticks for the streaming loop — skips the redundant symbol_info/symbol_select
    validation that get_ticks() performs on every call (the stream already validated on creation)."""
    require_connected_terminal()
    server = mt5_current_server_name()
    start_server_msc = mt5_utc_to_server_time_msc(int(from_msc), server)
    start_time = datetime.datetime.fromtimestamp(start_server_msc / 1000, datetime.timezone.utc)
    ticks = mt5.copy_ticks_from(ticker, start_time, count, mt5.COPY_TICKS_ALL)
    if ticks is None:
        raise RuntimeError(f"Could not read live {ticker} ticks from MetaTrader: {mt5.last_error()}")
    normalized_times_msc = normalize_mt5_server_timestamps(
        [int(tick["time_msc"]) for tick in ticks],
        server,
        anchor_utc_msc=int(from_msc),
    )
    return [
        {
            "time": time_msc,
            "bid": float(tick["bid"]),
            "ask": float(tick["ask"]),
            "last": float(tick["last"]),
            "volume": float(tick["volume"]),
            "volumeReal": float(tick["volume_real"]),
            "flags": int(tick["flags"]),
        }
        for tick, time_msc in zip(ticks, normalized_times_msc)
    ]


def run_tick_stream(subscription_id, ticker, stop_event, cursor):
    # The public cursor is UTC; _poll_ticks_raw maps it to the broker's timestamp basis.
    # symbol_info/symbol_select are already validated in create_tick_stream, so the hot loop
    # uses the lighter _poll_ticks_raw helper to avoid redundant terminal metadata calls.
    seen_at_cursor = {}
    try:
        while not stop_event.is_set():
            try:
                ticks = _poll_ticks_raw(ticker, cursor, 10_000)
                cursor, fresh_ticks = live_ticks_after_cursor(ticks, cursor, seen_at_cursor)
                if fresh_ticks:
                    emit({"event": "ticks", "subscriptionId": subscription_id, "ticker": ticker, "ticks": fresh_ticks})
                    # Ticks arrived — re-poll immediately to drain any burst before sleeping.
                    continue
            except Exception as error:
                print(f"MT5 tick stream error for {ticker}: {error}", file=sys.stderr, flush=True)
                # A temporary terminal disconnect should not leave a dead subscription in the UI.
                stop_event.wait(0.1)
                continue
            # No new ticks — yield the CPU for one poll interval before the next check.
            stop_event.wait(TICK_STREAM_POLL_SECONDS)
    finally:
        with tick_streams_lock:
            tick_streams.pop(subscription_id, None)


def create_tick_stream(request):
    ticker_value = request.get("ticker")
    ticker = ticker_value.strip() if isinstance(ticker_value, str) else ""
    if not ticker or len(ticker) > 100:
        raise RuntimeError("Enter a valid MetaTrader symbol.")
    require_connected_terminal()
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")
    tick = mt5.symbol_info_tick(ticker)
    tick_time_msc = int(getattr(tick, "time_msc", 0) or 0) if tick is not None else 0
    if tick_time_msc <= 0:
        raise RuntimeError(f"Could not read the latest {ticker} tick from MetaTrader: {mt5.last_error()}")
    reference_utc_msc = int(time.time() * 1000)
    tick_time_msc = mt5_server_to_utc_time_msc(
        tick_time_msc,
        mt5_current_server_name(),
        reference_utc_msc=reference_utc_msc,
    )
    # Clamp stream cursor so a broker server-clock offset does not set the cursor into
    # the future (which would cause copy_ticks_from to return nothing).
    if tick_time_msc > reference_utc_msc + 1000:
        tick_time_msc = reference_utc_msc
    subscription_id = str(uuid.uuid4())
    with tick_streams_lock:
        tick_streams[subscription_id] = {
            "ticker": ticker,
            "cursor": tick_time_msc + 1,
            "stop": threading.Event(),
            "thread": None,
        }
    return {"subscriptionId": subscription_id}


def start_tick_stream(subscription_id):
    with tick_streams_lock:
        stream = tick_streams.get(subscription_id)
        if stream is None or stream["thread"] is not None:
            return
        thread = threading.Thread(
            target=run_tick_stream,
            args=(subscription_id, stream["ticker"], stream["stop"], stream["cursor"]),
            name=f"mt5-ticks-{stream['ticker']}",
            daemon=True,
        )
        stream["thread"] = thread
        thread.start()


def stop_tick_stream(subscription_id):
    if not isinstance(subscription_id, str):
        return False
    with tick_streams_lock:
        stream = tick_streams.get(subscription_id)
        if stream is None:
            return False
        stream["stop"].set()
    return True


def stop_all_tick_streams():
    with tick_streams_lock:
        for stream in tick_streams.values():
            stream["stop"].set()


def get_market_book(request):
    require_connected_terminal()
    ticker_value = request.get("ticker")
    ticker = ticker_value.strip() if isinstance(ticker_value, str) else ""
    if not ticker or len(ticker) > 100:
        raise RuntimeError("Enter a valid MetaTrader symbol.")
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")
    if not mt5.market_book_add(ticker):
        raise RuntimeError(f"MetaTrader does not provide market depth for {ticker}: {mt5.last_error()}")
    try:
        entries = mt5.market_book_get(ticker)
        if entries is None:
            raise RuntimeError(f"Could not read {ticker} market depth from MetaTrader: {mt5.last_error()}")
        bid_types = {getattr(mt5, "BOOK_TYPE_BUY", -1), getattr(mt5, "BOOK_TYPE_BUY_MARKET", -2)}
        ask_types = {getattr(mt5, "BOOK_TYPE_SELL", -3), getattr(mt5, "BOOK_TYPE_SELL_MARKET", -4)}
        return [
            {
                "side": "bid" if entry.type in bid_types else "ask" if entry.type in ask_types else "unknown",
                "price": float(entry.price),
                "volume": float(entry.volume),
            }
            for entry in entries
        ]
    finally:
        mt5.market_book_release(ticker)


def handle(request):
    action = request.get("action")
    if action == "connect":
        require_mt5()
        terminal_path = initialize_terminal()
        terminal = wait_for_connected_terminal()
        account = mt5.account_info()
        if terminal is None or not terminal.connected:
            mt5.shutdown()
            raise RuntimeError("MetaTrader terminal is offline. Sign in to your broker account in MT5 and retry.")
        if account is None:
            raise RuntimeError("MetaTrader is connected but no broker account is signed in.")
        account_status = get_trading_status()
        return {
            "company": terminal.company or "",
            "terminal": terminal.name or "MetaTrader 5",
            "server": account.server or "",
            "accountLogin": str(getattr(account, "login", "") or ""),
            "terminalPath": terminal_path or "",
            "accountMode": account_status["accountMode"],
            "tradingAllowed": account_status["tradingAllowed"],
            "symbols": serialize_symbols(),
        }
    if action == "status":
        return get_trading_status()
    if action == "place_order":
        return place_market_order(request.get("order"))
    if action == "open_position":
        return open_position(request)
    if action == "verify_live_provenance":
        return verify_live_provenance(request)
    if action == "validate_protection":
        return validate_protection(request)
    if action == "get_position":
        return get_position(request)
    if action == "close_position":
        return close_position(request)
    if action == "reconcile_intent":
        return reconcile_intent(request)
    if action == "symbols":
        require_mt5()
        return serialize_symbols()
    if action == "info":
        require_mt5()
        return serialize_info(request.get("ticker", ""))
    if action == "bars":
        require_mt5()
        return get_bars(request)
    if action == "quote":
        require_mt5()
        return get_quote(request)
    if action == "ticks":
        require_mt5()
        return get_ticks(request)
    if action == "stream_ticks":
        require_mt5()
        return create_tick_stream(request)
    if action == "stop_tick_stream":
        return stop_tick_stream(request.get("subscriptionId"))
    if action == "market_book":
        require_mt5()
        return get_market_book(request)
    if action == "disconnect":
        stop_all_tick_streams()
        if mt5 is not None:
            mt5.shutdown()
        return True
    raise RuntimeError("Unsupported MetaTrader bridge operation.")


def serve():
    for input_line in sys.stdin:
        request = {}
        try:
            request = json.loads(input_line)
            result = handle(request)
            response = {"id": request.get("id"), "ok": True, "result": result}
        except Exception as error:
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": str(error),
                "phase": getattr(error, "phase", "pre-send"),
            }
        emit(response)
        if request.get("action") == "stream_ticks" and response.get("ok"):
            start_tick_stream(result.get("subscriptionId"))
        if isinstance(request, dict) and request.get("action") == "disconnect":
            break


if __name__ == "__main__":
    serve()
