"""Unit tests for model_registry.client — no network; fetch and clock are injected."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from model_registry import client  # noqa: E402

REG = {
    "schema_version": 2,
    "fetched_at": "2026-06-09T16:46:02Z",
    "providers_ok": ["anthropic", "openai", "gemini"],
    "available": {"anthropic": ["claude-opus-4-8", "claude-sonnet-4-6"]},
    "families": {
        "anthropic": {"opus": "claude-opus-4-8", "sonnet": "claude-sonnet-4-6"},
        "openai": {"gpt": "gpt-5.5"},
    },
    "families_detail": {
        "anthropic": {"opus": {"active": "claude-opus-4-8", "stable": "claude-opus-4-7"}},
    },
    "capabilities": {"claude-opus-4-8": {"context_window": 200000}},
}


def fetch_ok(url, timeout):
    return json.dumps(REG)


def fetch_fail(url, timeout):
    raise OSError("connection refused")


PRICING = {
    "fetched_at": "2026-06-10T18:46:06Z",
    "currency": "USD where published by provider",
    "unit_note": "Prices per 1M tokens unless a row says otherwise.",
    "providers": {
        "anthropic": {
            "name": "Anthropic",
            "token_pricing_tables": [
                {
                    "section": "Pricing > Model pricing",
                    "columns": ["Model", "Base Input Tokens", "Output Tokens"],
                    "rows": [
                        {
                            "Model": "Claude Fable 5",
                            "Base Input Tokens": "$10 / MTok",
                            "Output Tokens": "$50 / MTok",
                        }
                    ],
                },
                {
                    "section": "Pricing > Fast mode pricing",
                    "columns": ["Model", "Input", "Output"],
                    "rows": [
                        {"Model": "Claude Opus 4.6", "Input": "$30 / MTok", "Output": "$150 / MTok"}
                    ],
                },
            ],
        },
        "google": {
            "name": "Google",
            "token_pricing_tables": [
                {
                    "section": "Gemini > Flash > Standard",
                    "columns": ["Metric", "Paid Tier"],
                    "rows": [{"Metric": "Input price", "Paid Tier": "$1.50"}],
                }
            ],
        },
    },
}


def fetch_pricing_ok(url, timeout):
    return json.dumps(PRICING)


class ClientTests(unittest.TestCase):
    def setUp(self):
        client.clear_cache()
        os.environ.pop("MODEL_REGISTRY_URL", None)

    def test_fetch_parses_and_returns(self):
        reg = client.get_registry(_fetch=fetch_ok)
        self.assertEqual(reg["families"]["anthropic"]["opus"], "claude-opus-4-8")

    def test_cache_within_ttl_skips_fetch(self):
        calls = []

        def counting_fetch(url, timeout):
            calls.append(url)
            return json.dumps(REG)

        t = [1000.0]
        clock = lambda: t[0]  # noqa: E731
        client.get_registry(_fetch=counting_fetch, _clock=clock)
        t[0] += 100
        client.get_registry(_fetch=counting_fetch, _clock=clock)
        self.assertEqual(len(calls), 1)
        t[0] += 4000  # past the 3600s TTL
        client.get_registry(_fetch=counting_fetch, _clock=clock)
        self.assertEqual(len(calls), 2)

    def test_expired_cache_served_when_fetch_fails(self):
        t = [1000.0]
        clock = lambda: t[0]  # noqa: E731
        client.get_registry(_fetch=fetch_ok, _clock=clock)
        t[0] += 999999
        reg = client.get_registry(_fetch=fetch_fail, _clock=clock)
        self.assertEqual(reg["schema_version"], 2)

    def test_fallback_file_used_when_fetch_fails(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(REG, fh)
            path = fh.name
        try:
            reg = client.get_registry(_fetch=fetch_fail, fallback_path=path)
            self.assertEqual(reg["families"]["openai"]["gpt"], "gpt-5.5")
        finally:
            os.unlink(path)

    def test_raises_without_fallback(self):
        with self.assertRaises(client.RegistryError):
            client.get_registry(_fetch=fetch_fail)

    def test_invalid_schema_rejected(self):
        bad = lambda url, timeout: json.dumps({"schema_version": 1})  # noqa: E731
        with self.assertRaises(client.RegistryError):
            client.get_registry(_fetch=bad)

    def test_env_var_overrides_url(self):
        seen = []

        def spy_fetch(url, timeout):
            seen.append(url)
            return json.dumps(REG)

        os.environ["MODEL_REGISTRY_URL"] = "https://example.com/my.json"
        try:
            client.get_registry(_fetch=spy_fetch)
        finally:
            del os.environ["MODEL_REGISTRY_URL"]
        self.assertEqual(seen, ["https://example.com/my.json"])

    def test_resolve_active_and_stable_channels(self):
        self.assertEqual(client.resolve("anthropic", "opus", _fetch=fetch_ok), "claude-opus-4-8")
        self.assertEqual(
            client.resolve("anthropic", "opus", channel="stable", _fetch=fetch_ok),
            "claude-opus-4-7",
        )
        # channel absent in families_detail -> falls back to active
        self.assertEqual(
            client.resolve("anthropic", "sonnet", channel="stable", _fetch=fetch_ok),
            "claude-sonnet-4-6",
        )

    def test_resolve_unknown_family_raises_lookup(self):
        with self.assertRaises(LookupError):
            client.resolve("anthropic", "mega", _fetch=fetch_ok)
        with self.assertRaises(LookupError):
            client.resolve("nobody", "opus", _fetch=fetch_ok)

    def test_context_window_and_available(self):
        self.assertEqual(client.context_window("claude-opus-4-8", _fetch=fetch_ok), 200000)
        self.assertIsNone(client.context_window("unknown-model", _fetch=fetch_ok))
        self.assertIn("claude-opus-4-8", client.available("anthropic", _fetch=fetch_ok))
        self.assertEqual(client.available("nobody", _fetch=fetch_ok), [])


class PricingTests(unittest.TestCase):
    def setUp(self):
        client.clear_cache()
        os.environ.pop("MODEL_PRICING_URL", None)

    def test_fetch_parses_and_returns(self):
        doc = client.get_pricing(_fetch=fetch_pricing_ok)
        self.assertIn("anthropic", doc["providers"])

    def test_uses_pricing_url_not_registry_url(self):
        seen = []

        def spy_fetch(url, timeout):
            seen.append(url)
            return json.dumps(PRICING)

        client.get_pricing(_fetch=spy_fetch)
        self.assertEqual(seen, [client.DEFAULT_PRICING_URL])

    def test_env_var_overrides_url(self):
        seen = []

        def spy_fetch(url, timeout):
            seen.append(url)
            return json.dumps(PRICING)

        os.environ["MODEL_PRICING_URL"] = "https://example.com/pricing.json"
        try:
            client.get_pricing(_fetch=spy_fetch)
        finally:
            del os.environ["MODEL_PRICING_URL"]
        self.assertEqual(seen, ["https://example.com/pricing.json"])

    def test_invalid_document_rejected(self):
        bad = lambda url, timeout: json.dumps({"providers": []})  # noqa: E731
        with self.assertRaises(client.RegistryError):
            client.get_pricing(_fetch=bad)

    def test_fallback_file_used_when_fetch_fails(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(PRICING, fh)
            path = fh.name
        try:
            doc = client.get_pricing(_fetch=fetch_fail, fallback_path=path)
            self.assertEqual(doc["fetched_at"], PRICING["fetched_at"])
        finally:
            os.unlink(path)

    def test_raises_without_fallback(self):
        with self.assertRaises(client.RegistryError):
            client.get_pricing(_fetch=fetch_fail)

    def test_pricing_rows_flattens_with_section(self):
        rows = client.pricing_rows("anthropic", _fetch=fetch_pricing_ok)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["section"], "Pricing > Model pricing")
        self.assertEqual(rows[0]["Model"], "Claude Fable 5")
        self.assertEqual(rows[1]["section"], "Pricing > Fast mode pricing")

    def test_pricing_rows_unknown_provider_raises_lookup(self):
        with self.assertRaises(LookupError):
            client.pricing_rows("nobody", _fetch=fetch_pricing_ok)

    def test_registry_and_pricing_caches_are_independent(self):
        client.get_registry(_fetch=fetch_ok)
        doc = client.get_pricing(_fetch=fetch_pricing_ok)
        self.assertIn("providers", doc)
        reg = client.get_registry(_fetch=fetch_fail)  # served from cache, no fetch
        self.assertEqual(reg["schema_version"], 2)


if __name__ == "__main__":
    unittest.main()
