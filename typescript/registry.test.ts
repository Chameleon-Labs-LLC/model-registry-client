import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPricingClient,
  createRegistryClient,
  DEFAULT_PRICING_URL,
  DEFAULT_URL,
  type ModelRegistry,
  type PricingDocument,
} from "./registry.ts";

const REG: ModelRegistry = {
  schema_version: 2,
  fetched_at: "2026-06-09T16:46:02Z",
  providers_ok: ["anthropic", "openai"],
  available: { anthropic: ["claude-opus-4-8", "claude-sonnet-4-6"] },
  families: {
    anthropic: { opus: "claude-opus-4-8", sonnet: "claude-sonnet-4-6" },
    openai: { gpt: "gpt-5.5" },
  },
  families_detail: {
    anthropic: { opus: { active: "claude-opus-4-8", stable: "claude-opus-4-7" } },
  },
  capabilities: { "claude-opus-4-8": { context_window: 200000 } },
};

function okFetch(body: unknown = REG): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}
function recordingFetch(body: unknown): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return { ok: true, status: 200, json: async () => body };
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/**
 * Runs an async test with a URL environment variable temporarily set or unset.
 * Restores its previous value even if the test throws or rejects.
 */
async function withUrlEnv(
  name: "MODEL_REGISTRY_URL" | "MODEL_PRICING_URL",
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const failFetch = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

for (const scenario of [
  { name: "default URL", envUrl: undefined, optionUrl: undefined, expected: DEFAULT_URL },
  {
    name: "option URL", envUrl: undefined,
    optionUrl: "https://example.test/registry-option.json",
    expected: "https://example.test/registry-option.json",
  },
  {
    name: "environment URL", envUrl: "https://example.test/registry-env.json",
    optionUrl: undefined, expected: "https://example.test/registry-env.json",
  },
  {
    name: "option URL over environment URL",
    envUrl: "https://example.test/registry-env.json",
    optionUrl: "https://example.test/registry-option.json",
    expected: "https://example.test/registry-option.json",
  },
]) {
  test(`registry: fetches ${scenario.name}`, async () => {
    await withUrlEnv("MODEL_REGISTRY_URL", scenario.envUrl, async () => {
      const { fetchImpl, urls } = recordingFetch(REG);
      await createRegistryClient({ url: scenario.optionUrl, fetchImpl }).getRegistry();
      assert.deepEqual(urls, [scenario.expected]);
    });
  });
}

test("fetches and parses the registry", async () => {
  const c = createRegistryClient({ fetchImpl: okFetch() });
  const reg = await c.getRegistry();
  assert.equal(reg.families.anthropic!.opus, "claude-opus-4-8");
});

test("caches within TTL, refetches after expiry", async () => {
  let calls = 0;
  const counting = (async () => {
    calls++;
    return { ok: true, status: 200, json: async () => REG };
  }) as unknown as typeof fetch;
  let t = 1000;
  const c = createRegistryClient({ fetchImpl: counting, now: () => t });
  await c.getRegistry();
  t += 100_000;
  await c.getRegistry();
  assert.equal(calls, 1);
  t += 4_000_000; // past 1h TTL
  await c.getRegistry();
  assert.equal(calls, 2);
});

test("serves expired cache when fetch fails", async () => {
  let t = 1000;
  let impl = okFetch();
  const c = createRegistryClient({ fetchImpl: (...a) => impl(...a), now: () => t });
  await c.getRegistry();
  impl = failFetch;
  t += 100_000_000;
  const reg = await c.getRegistry();
  assert.equal(reg.schema_version, 2);
});

test("serves fallback when fetch fails and cache empty", async () => {
  const c = createRegistryClient({ fetchImpl: failFetch, fallback: REG });
  const reg = await c.getRegistry();
  assert.equal(reg.families.openai!.gpt, "gpt-5.5");
});

test("throws without fallback", async () => {
  const c = createRegistryClient({ fetchImpl: failFetch });
  await assert.rejects(() => c.getRegistry(), /no fallback/);
});

test("rejects invalid schema (falls back)", async () => {
  const c = createRegistryClient({ fetchImpl: okFetch({ schema_version: 1 }), fallback: REG });
  const reg = await c.getRegistry();
  assert.equal(reg.schema_version, 2); // fallback served
});

test("resolve: active, stable, absent-channel fallback, unknown family", async () => {
  const c = createRegistryClient({ fetchImpl: okFetch() });
  assert.equal(await c.resolve("anthropic", "opus"), "claude-opus-4-8");
  assert.equal(await c.resolve("anthropic", "opus", "stable"), "claude-opus-4-7");
  assert.equal(await c.resolve("anthropic", "sonnet", "stable"), "claude-sonnet-4-6");
  await assert.rejects(() => c.resolve("anthropic", "mega"), /no family anthropic\/mega/);
  await assert.rejects(() => c.resolve("nobody", "opus"), /no family nobody\/opus/);
});

test("contextWindow and available", async () => {
  const c = createRegistryClient({ fetchImpl: okFetch() });
  assert.equal(await c.contextWindow("claude-opus-4-8"), 200000);
  assert.equal(await c.contextWindow("unknown"), undefined);
  assert.deepEqual(await c.available("nobody"), []);
  assert.ok((await c.available("anthropic")).includes("claude-opus-4-8"));
});

test("clearCache forces refetch", async () => {
  let calls = 0;
  const counting = (async () => {
    calls++;
    return { ok: true, status: 200, json: async () => REG };
  }) as unknown as typeof fetch;
  const c = createRegistryClient({ fetchImpl: counting });
  await c.getRegistry();
  c.clearCache();
  await c.getRegistry();
  assert.equal(calls, 2);
});

// --- pricing client ---

const PRICING: PricingDocument = {
  fetched_at: "2026-06-10T18:46:06Z",
  currency: "USD where published by provider",
  unit_note: "Prices per 1M tokens unless a row says otherwise.",
  providers: {
    anthropic: {
      name: "Anthropic",
      token_pricing_tables: [
        {
          section: "Pricing > Model pricing",
          columns: ["Model", "Base Input Tokens", "Output Tokens"],
          rows: [
            { Model: "Claude Fable 5", "Base Input Tokens": "$10 / MTok", "Output Tokens": "$50 / MTok" },
          ],
        },
        {
          section: "Pricing > Fast mode pricing",
          columns: ["Model", "Input", "Output"],
          rows: [{ Model: "Claude Opus 4.6", Input: "$30 / MTok", Output: "$150 / MTok" }],
        },
      ],
    },
    google: {
      name: "Google",
      token_pricing_tables: [
        {
          section: "Gemini > Flash > Standard",
          columns: ["Metric", "Paid Tier"],
          rows: [{ Metric: "Input price", "Paid Tier": "$1.50" }],
        },
      ],
    },
  },
};

for (const scenario of [
  { name: "default URL", envUrl: undefined, optionUrl: undefined, expected: DEFAULT_PRICING_URL },
  {
    name: "option URL", envUrl: undefined,
    optionUrl: "https://example.test/pricing-option.json",
    expected: "https://example.test/pricing-option.json",
  },
  {
    name: "environment URL", envUrl: "https://example.test/pricing-env.json",
    optionUrl: undefined, expected: "https://example.test/pricing-env.json",
  },
  {
    name: "option URL over environment URL",
    envUrl: "https://example.test/pricing-env.json",
    optionUrl: "https://example.test/pricing-option.json",
    expected: "https://example.test/pricing-option.json",
  },
]) {
  test(`pricing: fetches ${scenario.name}`, async () => {
    await withUrlEnv("MODEL_PRICING_URL", scenario.envUrl, async () => {
      const { fetchImpl, urls } = recordingFetch(PRICING);
      await createPricingClient({ url: scenario.optionUrl, fetchImpl }).getPricing();
      assert.deepEqual(urls, [scenario.expected]);
    });
  });
}

test("pricing: fetches and parses the document", async () => {
  const c = createPricingClient({ fetchImpl: okFetch(PRICING) });
  const doc = await c.getPricing();
  assert.ok(doc.providers.anthropic);
  assert.equal(doc.fetched_at, PRICING.fetched_at);
});

test("pricing: caches within TTL", async () => {
  let calls = 0;
  const counting = (async () => {
    calls++;
    return { ok: true, status: 200, json: async () => PRICING };
  }) as unknown as typeof fetch;
  let t = 1000;
  const c = createPricingClient({ fetchImpl: counting, now: () => t });
  await c.getPricing();
  t += 100_000;
  await c.getPricing();
  assert.equal(calls, 1);
  t += 4_000_000;
  await c.getPricing();
  assert.equal(calls, 2);
});

test("pricing: serves fallback when fetch fails and cache empty", async () => {
  const c = createPricingClient({ fetchImpl: failFetch, fallback: PRICING });
  const doc = await c.getPricing();
  assert.equal(doc.currency, PRICING.currency);
});

test("pricing: throws without fallback", async () => {
  const c = createPricingClient({ fetchImpl: failFetch });
  await assert.rejects(() => c.getPricing(), /no fallback/);
});

test("pricing: rejects invalid document (falls back)", async () => {
  const c = createPricingClient({ fetchImpl: okFetch({ providers: [] }), fallback: PRICING });
  const doc = await c.getPricing();
  assert.equal(doc.fetched_at, PRICING.fetched_at);
});

test("pricing: rows flattens tables and tags section", async () => {
  const c = createPricingClient({ fetchImpl: okFetch(PRICING) });
  const rows = await c.rows("anthropic");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].section, "Pricing > Model pricing");
  assert.equal(rows[0].Model, "Claude Fable 5");
  assert.equal(rows[1].section, "Pricing > Fast mode pricing");
});

test("pricing: rows rejects unknown provider", async () => {
  const c = createPricingClient({ fetchImpl: okFetch(PRICING) });
  await assert.rejects(() => c.rows("nobody"), /no provider nobody/);
});
