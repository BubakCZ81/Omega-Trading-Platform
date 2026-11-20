import datetime
import importlib.util
import os
import types
import unittest
from unittest import mock


MODULE_PATH = os.path.join(os.path.dirname(__file__), "mt5_bridge.py")
SPEC = importlib.util.spec_from_file_location("omega_mt5_bridge_under_test", MODULE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class FakeMt5:
    TRADE_ACTION_DEAL = 1
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2
    ORDER_TIME_GTC = 0
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_REJECT = 10006
    SYMBOL_TRADE_MODE_DISABLED = 0
    SYMBOL_TRADE_MODE_LONGONLY = 1
    SYMBOL_TRADE_MODE_SHORTONLY = 2
    SYMBOL_TRADE_MODE_CLOSEONLY = 3
    SYMBOL_TRADE_MODE_FULL = 4
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1
    ACCOUNT_TRADE_MODE_REAL = 2
    SYMBOL_FILLING_FOK = 1
    SYMBOL_FILLING_IOC = 2
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1
    TIMEFRAME_M1 = 1
    COPY_TICKS_ALL = 0

    def __init__(self):
        self.sent = []
        self.positions = {}
        self.check_result = types.SimpleNamespace(retcode=0, comment="ok")
        self.send_result = types.SimpleNamespace(
            retcode=self.TRADE_RETCODE_DONE,
            order=42,
            deal=84,
            volume=0.01,
            price=1.1002,
            comment="filled",
            request_id=7,
            retcode_external=0,
        )
        self.direction_mode = self.SYMBOL_TRADE_MODE_FULL
        self.account_allowed = True
        self.terminal_allowed = True
        self.tick_time = bridge.time.time()
        self.login = 123456
        self.server = "Demo Server"
        self.on_order_check = None
        self.tick_history = []
        self.tick_start_time = None
        self.rates = []
        self.rates_range = None

    def terminal_info(self):
        return types.SimpleNamespace(connected=True, trade_allowed=self.terminal_allowed)

    def account_info(self):
        return types.SimpleNamespace(
            login=self.login,
            trade_allowed=self.account_allowed,
            trade_mode=self.ACCOUNT_TRADE_MODE_DEMO,
            server=self.server,
            currency="USD",
            equity=10_000.0,
        )

    def symbol_info(self, symbol):
        if symbol != "EURUSD":
            return None
        return types.SimpleNamespace(
            name=symbol,
            trade_mode=self.direction_mode,
            volume_min=0.01,
            volume_max=100.0,
            volume_step=0.01,
            point=0.00001,
            digits=5,
            trade_tick_size=0.00001,
            trade_stops_level=10,
            filling_mode=self.SYMBOL_FILLING_FOK | self.SYMBOL_FILLING_IOC,
        )

    def symbol_select(self, symbol, selected):
        return True

    def symbol_info_tick(self, symbol):
        return types.SimpleNamespace(
            time_msc=int(self.tick_time * 1000),
            bid=1.1000,
            ask=1.1002,
        )

    def copy_ticks_from(self, symbol, start_time, count, flags):
        assert count > 0 and flags == self.COPY_TICKS_ALL
        self.tick_start_time = start_time
        return self.tick_history[:count]

    def copy_rates_range(self, symbol, timeframe, start_time, end_time):
        self.rates_range = (start_time, end_time)
        return self.rates

    def copy_rates_from(self, symbol, timeframe, end_time, count):
        self.rates_ends.append(end_time)
        return [row for row in self.rates if row["time"] <= end_time.timestamp()][-count:]

    def order_check(self, request):
        if self.on_order_check:
            self.on_order_check()
        return self.check_result

    def order_send(self, request):
        self.sent.append(request)
        if isinstance(self.send_result, Exception):
            raise self.send_result
        return self.send_result

    def positions_get(self, ticket=None):
        if ticket is None:
            return list(self.positions.values())
        pos = self.positions.get(str(ticket))
        return [pos] if pos is not None else []

    def last_error(self):
        return (-1, "mock MT5 failure")


class LiveOrderBridgeTests(unittest.TestCase):
    def setUp(self):
        self.original_mt5 = bridge.mt5
        self.mt5 = FakeMt5()
        bridge.mt5 = self.mt5

    def tearDown(self):
        bridge.mt5 = self.original_mt5

    def order(self, side="BUY", **updates):
        request = {
            "symbol": "EURUSD",
            "side": side,
            "volume": 0.01,
            "stopLoss": 1.0990 if side == "BUY" else 1.1010,
            "takeProfit": 1.1020 if side == "BUY" else 1.0980,
            "expectedAccount": {"login": "123456", "server": "Demo Server"},
            "maxOrderVolume": 20,
        }
        request.update(updates)
        return request

    def test_quote_includes_the_timestamp_of_the_broker_tick(self):
        quote = bridge.get_quote({"ticker": "EURUSD"})
        self.assertEqual(quote["timeMsc"], int(self.mt5.tick_time * 1000))
        self.assertEqual(quote["bid"], 1.1000)
        self.assertEqual(quote["ask"], 1.1002)

    def test_pepperstone_quote_is_normalized_to_utc(self):
        now = bridge.time.time()
        self.mt5.server = "PepperstoneUK-Demo"
        self.mt5.tick_time = now + bridge.PEPPERSTONE_STANDARD_OFFSET_SECONDS

        quote = bridge.get_quote({"ticker": "EURUSD"})

        self.assertLess(abs(quote["timeMsc"] / 1000 - now), 1)

    def test_stale_snapshot_is_recovered_from_real_pepperstone_quote_history(self):
        now = bridge.time.time()
        now_msc = int(now * 1000)
        self.mt5.server = "PepperstoneUK-Demo"
        self.mt5.tick_time = bridge.mt5_utc_to_server_time_msc(now_msc - 63_000, self.mt5.server) / 1000
        latest_msc = now_msc - 2_000
        self.mt5.tick_history = [{
            "time_msc": bridge.mt5_utc_to_server_time_msc(latest_msc, self.mt5.server),
            "bid": 1.1001,
            "ask": 1.1003,
        }]

        quote = bridge.get_quote({"ticker": "EURUSD"})
        self.assertEqual(quote, {"bid": 1.1001, "ask": 1.1003, "timeMsc": latest_msc})

        result = bridge.place_market_order(self.order(
            expectedAccount={"login": "123456", "server": "PepperstoneUK-Demo"},
        ))
        self.assertEqual(result["status"], "filled")
        self.assertEqual(self.mt5.sent[0]["price"], 1.1003)

    def test_pepperstone_order_freshness_uses_normalized_utc_tick_time(self):
        now = bridge.time.time()
        self.mt5.server = "PepperstoneUK-Demo"
        self.mt5.tick_time = now + bridge.PEPPERSTONE_STANDARD_OFFSET_SECONDS

        result = bridge.place_market_order(self.order(
            expectedAccount={"login": "123456", "server": "PepperstoneUK-Demo"},
        ))

        self.assertEqual(result["status"], "filled")
        self.assertEqual(len(self.mt5.sent), 1)

    def test_get_ticks_converts_utc_cursor_and_normalizes_pepperstone_ticks(self):
        now_msc = int(bridge.time.time() * 1000)
        raw_tick_msc = bridge.mt5_utc_to_server_time_msc(now_msc, "PepperstoneUK-Demo")
        self.mt5.server = "PepperstoneUK-Demo"
        self.mt5.tick_history = [{
            "time_msc": raw_tick_msc,
            "bid": 1.1,
            "ask": 1.2,
            "last": 0,
            "volume": 0,
            "volume_real": 0,
            "flags": 2,
        }]

        ticks = bridge.get_ticks({"ticker": "EURUSD", "fromMsc": now_msc, "limit": 1})

        self.assertEqual(ticks[0]["time"], now_msc)
        self.assertEqual(
            self.mt5.tick_start_time,
            bridge.datetime.datetime.fromtimestamp(raw_tick_msc / 1000, bridge.datetime.timezone.utc),
        )

    def test_get_bars_converts_pepperstone_range_and_normalizes_bar_times(self):
        now_msc = int(bridge.time.time() * 1000)
        from_msc = now_msc - 60_000
        raw_bar_msc = bridge.mt5_utc_to_server_time_msc(now_msc, "PepperstoneUK-Demo")
        self.mt5.server = "PepperstoneUK-Demo"
        self.mt5.rates = [{
            "time": raw_bar_msc // 1000,
            "open": 1.1,
            "high": 1.2,
            "low": 1.0,
            "close": 1.15,
            "real_volume": 10,
        }]

        bars = bridge.get_bars({
            "ticker": "EURUSD",
            "timeframe": "M1",
            "range": {"from": from_msc, "to": now_msc, "limit": 10},
        })

        self.assertEqual(bars[0]["time"], now_msc // 1000 * 1000)
        self.assertEqual(
            self.mt5.rates_range,
            (
                bridge.datetime.datetime.fromtimestamp(
                    bridge.mt5_utc_to_server_time_msc(from_msc, "PepperstoneUK-Demo") / 1000,
                    bridge.datetime.timezone.utc,
                ),
                bridge.datetime.datetime.fromtimestamp(
                    bridge.mt5_utc_to_server_time_msc(now_msc, "PepperstoneUK-Demo") / 1000,
                    bridge.datetime.timezone.utc,
                ),
            ),
        )

    def test_serialize_bar_falls_back_to_tick_volume_when_real_volume_is_unavailable(self):
        real_volume_bar = bridge.serialize_bar({
            "open": 1, "high": 2, "low": 1, "close": 1.5,
            "real_volume": 0, "tick_volume": 123,
        }, 1_700_000_000_000)
        self.assertEqual(real_volume_bar["volume"], 123)

        real_volume_present = bridge.serialize_bar({
            "open": 1, "high": 2, "low": 1, "close": 1.5,
            "real_volume": 45, "tick_volume": 123,
        }, 1_700_000_000_000)
        self.assertEqual(real_volume_present["volume"], 45)

    def test_get_bars_pages_back_from_a_historical_end_without_loading_newer_bars(self):
        end = int(bridge.time.time()) - 600
        self.mt5.rates_ends = []
        self.mt5.rates = [
            {"time": end + offset * 60, "open": 1, "high": 2, "low": 1, "close": 2, "real_volume": 1}
            for offset in range(-4, 2)
        ]
        with mock.patch.object(bridge, "MAX_RATES_PER_CALL", 2):
            bars = bridge.get_bars({
                "ticker": "EURUSD", "timeframe": "M1", "range": {"to": end * 1000, "limit": 3},
            })
        self.assertEqual([bar["time"] for bar in bars], [(end - 120) * 1000, (end - 60) * 1000, end * 1000])
        self.assertEqual([value.timestamp() for value in self.mt5.rates_ends], [end, end - 61])

    def test_tick_stream_starts_after_terminal_tick_not_computer_clock(self):
        result = bridge.create_tick_stream({"ticker": "EURUSD"})
        stream = bridge.tick_streams[result["subscriptionId"]]
        self.assertEqual(stream["cursor"], int(self.mt5.tick_time * 1000) + 1)
        self.assertTrue(bridge.stop_tick_stream(result["subscriptionId"]))
        with bridge.tick_streams_lock:
            bridge.tick_streams.pop(result["subscriptionId"], None)

    def test_tick_stream_discards_history_and_deduplicates_inclusive_poll_boundaries(self):
        baseline = [
            {"time": 1002, "bid": 1.1, "ask": 1.2, "last": 0, "volume": 0, "volumeReal": 0, "flags": 2},
            {"time": 1002, "bid": 1.1, "ask": 1.2, "last": 0, "volume": 0, "volumeReal": 0, "flags": 2},
        ]
        cursor = 1002
        seen = {}
        cursor, first = bridge.live_ticks_after_cursor([
            {"time": 1001, "bid": 1.0, "ask": 1.1, "last": 0, "volume": 0, "volumeReal": 0, "flags": 2},
            *baseline,
        ], cursor, seen)
        self.assertEqual([tick["time"] for tick in first], [1002, 1002])
        self.assertEqual(cursor, 1002)

        cursor, repeated = bridge.live_ticks_after_cursor([
            *baseline,
            {"time": 1003, "bid": 1.2, "ask": 1.3, "last": 0, "volume": 0, "volumeReal": 0, "flags": 2},
        ], cursor, seen)
        self.assertEqual([tick["time"] for tick in repeated], [1003])
        self.assertEqual(cursor, 1003)

    def test_buy_market_order_is_checked_and_serialized(self):
        result = bridge.place_market_order(self.order("BUY"))
        self.assertEqual(result["status"], "filled")
        self.assertEqual(result["retcode"], self.mt5.TRADE_RETCODE_DONE)
        self.assertEqual(self.mt5.sent[0]["type"], self.mt5.ORDER_TYPE_BUY)
        self.assertEqual(self.mt5.sent[0]["sl"], 1.099)
        self.assertEqual(self.mt5.sent[0]["tp"], 1.102)

    def test_refuses_account_change_and_volume_over_configured_default(self):
        order = self.order()
        order["expectedAccount"] = {"login": "other", "server": "Demo Server"}
        with self.assertRaisesRegex(bridge.BridgeOperationError, "account or server changed"):
            bridge.place_market_order(order)
        self.assertEqual(self.mt5.sent, [])
        with self.assertRaisesRegex(bridge.BridgeOperationError, "configured 20-lot"):
            bridge.place_market_order(self.order(volume=20.01))
        self.assertEqual(self.mt5.sent, [])

    def test_refuses_stale_quote_with_last_tick_age_and_no_order_send(self):
        self.mt5.tick_time = bridge.time.time() - 60
        with self.assertRaisesRegex(bridge.BridgeOperationError, r"stale quote.*60 seconds old.*Market Watch"):
            bridge.place_market_order(self.order())
        self.assertEqual(self.mt5.sent, [])

    def test_refuses_future_server_timestamp_with_clear_error_and_no_order_send(self):
        self.mt5.tick_time = bridge.time.time() + 7200
        with self.assertRaisesRegex(bridge.BridgeOperationError, r"timestamp is 7200 seconds ahead.*feed timestamp basis"):
            bridge.place_market_order(self.order())
        self.assertEqual(self.mt5.sent, [])

    def test_refuses_account_change_between_precheck_and_send(self):
        self.mt5.on_order_check = lambda: setattr(self.mt5, "login", 654321)
        with self.assertRaisesRegex(bridge.BridgeOperationError, "changed during pre-check"):
            bridge.place_market_order(self.order())
        self.assertEqual(self.mt5.sent, [])

    def test_volume_cap_can_be_configured_and_invalid_value_fails_closed(self):
        result = bridge.place_market_order(self.order(volume=0.02, maxOrderVolume=0.02))
        self.assertEqual(result["status"], "filled")
        self.assertEqual(len(self.mt5.sent), 1)

        with self.assertRaisesRegex(bridge.BridgeOperationError, "must be positive and no greater than 20"):
            bridge.place_market_order(self.order(maxOrderVolume=20.1))
        with self.assertRaisesRegex(bridge.BridgeOperationError, "trusted MT5 order-volume safeguard is invalid"):
            bridge.place_market_order(self.order(maxOrderVolume="not-a-number"))
    def test_sell_market_order_uses_bid_and_sell_constraints(self):
        result = bridge.place_market_order(self.order("SELL"))
        self.assertEqual(result["status"], "filled")
        self.assertEqual(self.mt5.sent[0]["type"], self.mt5.ORDER_TYPE_SELL)
        self.assertEqual(self.mt5.sent[0]["price"], 1.1)

    def test_rejects_bad_size_stops_or_disabled_trade_before_send(self):
        with self.assertRaisesRegex(bridge.BridgeOperationError, "volume"):
            bridge.place_market_order(self.order(volume=0.015))
        with self.assertRaisesRegex(bridge.BridgeOperationError, "stop-loss"):
            bridge.place_market_order(self.order(stopLoss=1.1010))
        self.mt5.direction_mode = self.mt5.SYMBOL_TRADE_MODE_SHORTONLY
        with self.assertRaisesRegex(bridge.BridgeOperationError, "does not allow BUY"):
            bridge.place_market_order(self.order("BUY"))
        self.assertEqual(self.mt5.sent, [])

    def test_requires_terminal_and_account_trading_permissions(self):
        self.mt5.account_allowed = False
        with self.assertRaisesRegex(bridge.BridgeOperationError, "account does not permit"):
            bridge.place_market_order(self.order())
        self.assertEqual(self.mt5.sent, [])
        self.mt5.account_allowed = True
        self.mt5.terminal_allowed = False
        with self.assertRaisesRegex(bridge.BridgeOperationError, "terminal does not permit"):
            bridge.place_market_order(self.order())
        self.assertEqual(self.mt5.sent, [])

    def test_precheck_rejection_does_not_send_and_send_rejection_is_reported(self):
        self.mt5.check_result = types.SimpleNamespace(retcode=10016, comment="invalid stops")
        with self.assertRaisesRegex(bridge.BridgeOperationError, "invalid stops") as caught:
            bridge.place_market_order(self.order())
        self.assertEqual(caught.exception.phase, "pre-send")
        self.assertEqual(self.mt5.sent, [])
        self.mt5.check_result = types.SimpleNamespace(retcode=0, comment="ok")
        self.mt5.send_result = types.SimpleNamespace(
            retcode=self.mt5.TRADE_RETCODE_REJECT,
            comment="market closed",
        )
        result = bridge.place_market_order(self.order())
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["comment"], "market closed")

    def test_ambiguous_order_send_result_is_marked_unknown(self):
        self.mt5.send_result = None
        result = bridge.place_market_order(self.order())
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(len(self.mt5.sent), 1)

    def test_order_send_exception_is_marked_as_uncertain(self):
        self.mt5.send_result = OSError("bridge lost after send")
        with self.assertRaisesRegex(bridge.BridgeOperationError, "may have started") as caught:
            bridge.place_market_order(self.order())
        self.assertEqual(caught.exception.phase, "send-unknown")
        self.assertEqual(len(self.mt5.sent), 1)


class PepperstoneTimestampTests(unittest.TestCase):
    def test_dst_offset_matches_us_transition_boundaries(self):
        cases = [
            ("2026-03-08T06:59:59+00:00", bridge.PEPPERSTONE_STANDARD_OFFSET_SECONDS),
            ("2026-03-08T07:00:00+00:00", bridge.PEPPERSTONE_DAYLIGHT_OFFSET_SECONDS),
            ("2026-11-01T05:59:59+00:00", bridge.PEPPERSTONE_DAYLIGHT_OFFSET_SECONDS),
            ("2026-11-01T06:00:00+00:00", bridge.PEPPERSTONE_STANDARD_OFFSET_SECONDS),
        ]
        for value, expected_offset in cases:
            with self.subTest(value=value):
                timestamp = int(datetime.datetime.fromisoformat(value).timestamp() * 1000)
                self.assertEqual(bridge.pepperstone_offset_at_utc(timestamp), expected_offset)

    def test_converts_summer_and_winter_server_timestamps_to_utc(self):
        for value in ("2026-03-06T12:34:56+00:00", "2026-11-06T12:34:56+00:00"):
            with self.subTest(value=value):
                utc_msc = int(datetime.datetime.fromisoformat(value).timestamp() * 1000)
                server_msc = bridge.mt5_utc_to_server_time_msc(utc_msc, "PepperstoneUK-Demo")
                self.assertEqual(
                    bridge.mt5_server_to_utc_time_msc(server_msc, "PepperstoneUK-Demo"),
                    utc_msc,
                )

    def test_fall_back_sequence_resolves_repeated_server_hour_monotonically(self):
        before_utc = int(datetime.datetime(2026, 11, 1, 5, 59, 59, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        after_utc = int(datetime.datetime(2026, 11, 1, 6, 0, 0, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        raw_times = [
            before_utc + bridge.PEPPERSTONE_DAYLIGHT_OFFSET_SECONDS * 1000,
            after_utc + bridge.PEPPERSTONE_STANDARD_OFFSET_SECONDS * 1000,
        ]

        result = bridge.normalize_mt5_server_timestamps(raw_times, "PepperstoneUK-Demo")

        self.assertEqual(result, [before_utc, after_utc])

    def test_fall_back_ambiguous_time_uses_utc_reference(self):
        raw_server_time = int(datetime.datetime(2026, 11, 1, 8, 30, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        first_occurrence = int(datetime.datetime(2026, 11, 1, 5, 30, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        second_occurrence = int(datetime.datetime(2026, 11, 1, 6, 30, tzinfo=datetime.timezone.utc).timestamp() * 1000)

        self.assertEqual(
            bridge.mt5_server_to_utc_time_msc(raw_server_time, "PepperstoneUK-Demo", reference_utc_msc=first_occurrence),
            first_occurrence,
        )
        self.assertEqual(
            bridge.mt5_server_to_utc_time_msc(raw_server_time, "PepperstoneUK-Demo", reference_utc_msc=second_occurrence),
            second_occurrence,
        )

    def test_unknown_server_timestamps_are_not_shifted(self):
        value = int(datetime.datetime(2026, 11, 6, 12, 34, 56, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        self.assertEqual(bridge.mt5_server_to_utc_time_msc(value, "OtherBroker-Demo"), value)

    def test_pepperstone_conversion_refuses_unverified_historical_dst_rules(self):
        value = int(datetime.datetime(2006, 11, 6, 12, 34, 56, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        with self.assertRaisesRegex(RuntimeError, "only verified for 2007 and later"):
            bridge.mt5_server_to_utc_time_msc(value, "PepperstoneUK-Demo")


class StrategyBridgeTests(unittest.TestCase):
    def setUp(self):
        self.original_mt5 = bridge.mt5
        self.mt5 = FakeMt5()
        bridge.mt5 = self.mt5
        self.account = {"login": "123456", "server": "Demo Server"}

    def tearDown(self):
        bridge.mt5 = self.original_mt5

    def live_intent(self, **updates):
        request = {
            "symbol": "EURUSD",
            "side": "BUY",
            "volume": 0.01,
            "stopLoss": 1.0990,
            "takeProfit": 1.1020,
            "emittedAt": int(bridge.time.time() * 1000),
            "provenance": {
                "environment": "live",
                "signalState": "confirmed",
                "marketData": "live",
                "providerEventId": "mt5-live-event-001",
                "replay": False,
                "backtest": False,
                "paper": False,
            },
        }
        request.update(updates)
        return request

    def test_verify_live_provenance_accepts_confirmed_live_event(self):
        result = bridge.verify_live_provenance(self.live_intent())
        self.assertTrue(result["verified"])
        self.assertEqual(result["eventId"], "mt5-live-event-001")

    def test_verify_live_provenance_rejects_non_live_environment(self):
        prov = dict(self.live_intent()["provenance"]); prov["environment"] = "paper"
        with self.assertRaisesRegex(bridge.BridgeOperationError, "Only confirmed live provider events"):
            bridge.verify_live_provenance(self.live_intent(provenance=prov))

    def test_verify_live_provenance_rejects_replay(self):
        prov = dict(self.live_intent()["provenance"]); prov["replay"] = True
        with self.assertRaisesRegex(bridge.BridgeOperationError, "Replay signals are not eligible"):
            bridge.verify_live_provenance(self.live_intent(provenance=prov))

    def test_verify_live_provenance_rejects_stale_intent(self):
        old = int(bridge.time.time() * 1000) - 20_000
        with self.assertRaisesRegex(bridge.BridgeOperationError, "stale"):
            bridge.verify_live_provenance(self.live_intent(emittedAt=old))

    def test_verify_live_provenance_requires_trading_allowed(self):
        self.mt5.account_allowed = False
        with self.assertRaisesRegex(bridge.BridgeOperationError, "must permit trading"):
            bridge.verify_live_provenance(self.live_intent())

    def test_validate_protection_accepts_valid_stops(self):
        result = bridge.validate_protection({
            "symbol": "EURUSD", "side": "BUY", "stopLoss": 1.0950, "takeProfit": 1.1050,
        })
        self.assertTrue(result["valid"])

    def test_validate_protection_rejects_buy_stop_above_bid(self):
        with self.assertRaisesRegex(bridge.BridgeOperationError, "must be below the current bid"):
            bridge.validate_protection({
                "symbol": "EURUSD", "side": "BUY", "stopLoss": 1.1010,
            })

    def test_validate_protection_rejects_sell_take_profit_above_ask(self):
        with self.assertRaisesRegex(bridge.BridgeOperationError, "must be below the current ask"):
            bridge.validate_protection({
                "symbol": "EURUSD", "side": "SELL", "stopLoss": 1.1050, "takeProfit": 1.1010,
            })

    def test_open_position_returns_filled_with_ticket(self):
        result = bridge.open_position({
            "symbol": "EURUSD", "side": "BUY", "volume": 0.01, "stopLoss": 1.0990,
            "takeProfit": 1.1020, "expectedAccount": self.account, "maxOrderVolume": 0.1,
        })
        self.assertEqual(result["status"], "filled")
        self.assertEqual(result["positionTicket"], "42")
        self.assertEqual(result["filledVolume"], 0.01)

    def test_open_position_requires_expected_account(self):
        with self.assertRaisesRegex(bridge.BridgeOperationError, "trusted MT5 account identity"):
            bridge.open_position({
                "symbol": "EURUSD", "side": "BUY", "volume": 0.01, "stopLoss": 1.0990,
            })

    def test_get_position_returns_none_when_flat(self):
        result = bridge.get_position({"positionTicket": "999"})
        self.assertIsNone(result)

    def test_get_position_returns_position(self):
        self.mt5.positions = {
            "7001": types.SimpleNamespace(
                ticket="7001", symbol="EURUSD", volume=0.01, price_open=1.1002,
                type=self.mt5.POSITION_TYPE_BUY, profit=12.50,
            )
        }
        result = bridge.get_position({"positionTicket": "7001"})
        self.assertIsNotNone(result)
        self.assertEqual(result["ticket"], "7001")
        self.assertEqual(result["side"], "BUY")
        self.assertEqual(result["volume"], 0.01)

    def test_close_position_closes_by_ticket(self):
        self.mt5.positions = {
            "7001": types.SimpleNamespace(
                ticket="7001", symbol="EURUSD", volume=0.01, price_open=1.1002,
                type=self.mt5.POSITION_TYPE_BUY, profit=12.50,
            )
        }
        result = bridge.close_position({
            "positionTicket": "7001", "symbol": "EURUSD", "side": "BUY", "volume": 0.01,
            "expectedAccount": self.account,
        })
        self.assertEqual(result["status"], "filled")
        self.assertEqual(result["positionTicket"], "7001")
        self.assertEqual(self.mt5.sent[0]["position"], 7001)

    def test_close_position_requires_expected_account(self):
        with self.assertRaisesRegex(bridge.BridgeOperationError, "trusted MT5 account identity"):
            bridge.close_position({
                "positionTicket": "7001", "symbol": "EURUSD", "side": "BUY", "volume": 0.01,
            })

    def test_reconcile_intent_confirms_open_position_exists(self):
        self.mt5.positions = {
            "7001": types.SimpleNamespace(
                ticket="7001", symbol="EURUSD", volume=0.01, price_open=1.1002,
                type=self.mt5.POSITION_TYPE_BUY, profit=12.50,
            )
        }
        result = bridge.reconcile_intent({
            "intentId": "00000000-0000-4000-8000-000000000001",
            "action": "open", "positionTicket": "7001", "account": self.account,
        })
        self.assertTrue(result["confirmed"])
        self.assertEqual(result["status"], "filled")
        self.assertEqual(result["filledVolume"], 0.01)

    def test_reconcile_intent_confirms_closed_flat(self):
        result = bridge.reconcile_intent({
            "intentId": "00000000-0000-4000-8000-000000000001",
            "action": "close", "positionTicket": "7001", "account": self.account,
        })
        self.assertTrue(result["confirmed"])
        self.assertEqual(result["status"], "closed-flat")

    def test_reconcile_intent_unknown_when_position_missing_for_open(self):
        result = bridge.reconcile_intent({
            "intentId": "00000000-0000-4000-8000-000000000001",
            "action": "open", "positionTicket": "9999", "account": self.account,
        })
        self.assertFalse(result["confirmed"])
        self.assertEqual(result["status"], "unknown")

    def test_reconcile_intent_requires_account_identity(self):
        with self.assertRaisesRegex(bridge.BridgeOperationError, "account identity is required"):
            bridge.reconcile_intent({
                "intentId": "00000000-0000-4000-8000-000000000001",
                "action": "open", "positionTicket": "7001", "account": {},
            })


if __name__ == "__main__":
    unittest.main()
