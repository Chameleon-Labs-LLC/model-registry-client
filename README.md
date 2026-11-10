# model-registry-client

Stop hardcoding LLM model IDs. These tiny, zero-dependency clients (Python + TypeScript)
resolve the **current** model ID for a provider/family pair at runtime from a published
model registry — so when `claude-opus-4-8` becomes `claude-opus-4-9`, your apps pick it
up automatically, with no code change and no deploy.

By default they read the **ChameleonLabs public model registry**, refreshed daily:

```
https://chameleonlabs-model-registry.s3.us-east-1.amazonaws.com/models/latest.json
```

You can point them at your own registry instead (see [Bring your own registry](#bring-your-own-registry)).

## Quick start

**Python** (stdlib only, Python ≥ 3.9):

```bash
pip install "chameleonlabs-model-registry @ git+https://github.com/Chameleon-Labs-LLC/model-registry-client#subdirectory=python"
```

```python
from model_registry import resolve, context_window, available

model_id = resolve("anthropic", "opus")          # -> "claude-opus-4-8" (today)
stable   = resolve("openai", "gpt", channel="stable")
window   = context_window(model_id)              # -> 1000000
ids      = available("gemini")                   # full curated list
```

**TypeScript / Node ≥ 22.6** (zero deps):

```ts
import { createRegistryClient } from "@chameleonlabs/model-registry";
// or vendor typescript/registry.ts into your project

const registry = createRegistryClient();
const modelId = await registry.resolve("anthropic", "opus");
const window = await registry.contextWindow(modelId);
```

**Anything else** — it's just JSON over HTTPS:

```bash
curl -s https://chameleonlabs-model-registry.s3.us-east-1.amazonaws.com/models/latest.json \
  | jq -r '.families.anthropic.opus'
```

## Vendoring (zero dependencies)

Both clients are single files designed to be copied into your project as-is:

- Python: [`python/src/model_registry/client.py`](python/src/model_registry/client.py)
- TypeScript: [`typescript/registry.ts`](typescript/registry.ts)

## Reliability: the fallback pattern

The clients cache in memory (1-hour TTL, 5-second fetch timeout) and degrade gracefully:

**fetch fails → serve cache (even expired) → serve bundled fallback → only then error.**

For production apps, snapshot the registry into your repo as a *last-known-good* fallback
and pass it in — then the client **never throws** and your model picker always works:

```bash
curl -sf https://chameleonlabs-model-registry.s3.us-east-1.amazonaws.com/models/latest.json \
  -o model-registry.fallback.json
```

```python
resolve("anthropic", "opus", fallback_path="model-registry.fallback.json")
```

```ts
import fallback from "./model-registry.fallback.json" with { type: "json" }; // Node 24+
const registry = createRegistryClient({ fallback });
```

Refresh the snapshot in CI/build (e.g. an Amplify/Netlify prebuild `curl`) so the
fallback never drifts far. The registry updates daily, so even a week-stale fallback is
serviceable — availability beats freshness.

## Registry schema (v2)

| Key | Meaning |
|-----|---------|
| `schema_version` | `2` — clients validate `>= 2` |
| `fetched_at` | ISO-8601 timestamp of the producer run |
| `providers_ok` | providers whose API listing succeeded this run |
| `families[provider][family]` | **primary lookup** — the current model ID for a family, e.g. `families.anthropic.opus` → `"claude-opus-4-8"` |
| `families_detail[provider][family]` | `{active, stable?, preview?}` channel variants |
| `available[provider]` | full curated model-ID list per provider |
| `capabilities[model_id]` | `{context_window?}` (tokens) |
| `unmatched[provider]` | listed IDs that didn't map to any family (informational) |

Current families:

| Provider | Families |
|----------|----------|
| `anthropic` | `opus`, `sonnet`, `haiku` |
| `openai` | `gpt`, `gpt-mini`, `gpt-nano`, `gpt-pro`, `chat` |
| `gemini` | `pro`, `flash`, `flash-lite` |

## Token pricing feed

The same bucket publishes a **daily token-pricing feed** — each provider's official
pricing page, scraped and captured as structured tables:

```
https://chameleonlabs-model-registry.s3.us-east-1.amazonaws.com/pricing/latest.json
```

(plus dated history at `pricing/YYYY-MM-DD.json`). It's a *faithful capture*, not a
normalized rate card: `providers[provider].token_pricing_tables` is a list of
`{section, columns, rows}` tables whose row keys are the provider's own column headers
(OpenAI and Anthropic key rows by `"Model"`, Google by `"Metric"`). Check `unit_note` —
prices are usually per 1M tokens.

```python
from model_registry import get_pricing, pricing_rows

doc  = get_pricing()                      # full document
rows = pricing_rows("anthropic")          # all rows, each tagged with its "section"
```

```ts
import { createPricingClient } from "@chameleonlabs/model-registry";

const pricing = createPricingClient();
const doc = await pricing.getPricing();
const rows = await pricing.rows("anthropic");
```

Same cache TTL, timeout, and fetch-fail ladder as the registry client; override the URL
with `MODEL_PRICING_URL` or `url=` / `{ url }`.

## Bring your own registry

Publish any JSON matching the schema above to a public URL, then either:

- set the `MODEL_REGISTRY_URL` environment variable, or
- pass it explicitly: `get_registry(url=...)` / `createRegistryClient({ url })`.

The ChameleonLabs registry is produced by a daily agent that queries each provider's
model-listing API and ranks the newest model per family. Any process that emits the
same shape works — even a hand-maintained static file.

## API

**Python** — `from model_registry import ...`

| Function | Description |
|----------|-------------|
| `resolve(provider, family, channel="active", *, url=None, fallback_path=None, ttl_seconds=3600)` | family → current model ID; `LookupError` if unknown |
| `get_registry(...)` | the full parsed registry dict |
| `context_window(model_id, ...)` | tokens or `None` |
| `available(provider, ...)` | curated ID list |
| `get_pricing(*, url=None, fallback_path=None, ttl_seconds=3600)` | the full token-pricing document |
| `pricing_rows(provider, ...)` | provider's pricing rows flattened, each tagged with `"section"`; `LookupError` if unknown |
| `clear_cache()` | drop the in-memory cache |

**TypeScript** — `createRegistryClient({ url?, fallback?, ttlMs?, fetchImpl?, now? })` returns
`{ getRegistry, resolve, contextWindow, available, clearCache }` (all async except `clearCache`).
`createPricingClient(...)` takes the same options and returns `{ getPricing, rows, clearCache }`.

## Tests

```bash
cd python && python3 -m unittest discover -s tests   # 19 tests
cd typescript && node --test registry.test.ts        # 24 tests
```

No network needed — fetch and clock are injectable.

## License

MIT © Chameleon Labs LLC
