/**
 * ChameleonLabs model-registry client (TypeScript).
 *
 * Resolves current LLM model IDs from a published registry JSON (schema v2) so projects
 * never hardcode model IDs that go stale. Zero dependencies — vendor this file or
 * `npm install github:Chameleon-Labs-LLC/model-registry-client`.
 *
 * Default registry: the public ChameleonLabs registry, refreshed daily. Point it at your
 * own with the MODEL_REGISTRY_URL env var or the `url` option.
 *
 * Error posture: fetch failure -> serve in-memory cache (even expired) -> serve the
 * `fallback` value (if provided) -> throw. With a fallback the client never throws, so
 * model pickers always work. Pass the fallback as a parsed value — e.g. in Node 24+:
 *   import fallback from "./model-registry.fallback.json" with { type: "json" };
 */

export type Provider = string; // "anthropic" | "openai" | "gemini" | your own

export interface ModelRegistry {
  schema_version: number;
  fetched_at: string;
  providers_ok: Provider[];
  available: Partial<Record<Provider, string[]>>;
  families: Partial<Record<Provider, Record<string, string>>>;
  families_detail?: Partial<
    Record<Provider, Record<string, { active: string; stable?: string; preview?: string }>>
  >;
  capabilities?: Record<string, { context_window?: number }>;
  unmatched?: Partial<Record<Provider, string[]>>;
}

export interface RegistryClientOptions {
  /** Registry URL. Default: MODEL_REGISTRY_URL env var, else the public ChameleonLabs URL. */
  url?: string;
  /** Last-known-good registry value (a snapshotted latest.json). Enables never-throw mode. */
  fallback?: ModelRegistry;
  /** Cache TTL in ms. Default 1 hour. */
  ttlMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const DEFAULT_URL =
  "https://chameleonlabs-model-registry.s3.us-east-1.amazonaws.com/models/latest.json";
export const DEFAULT_PRICING_URL =
  "https://chameleonlabs-model-registry.s3.us-east-1.amazonaws.com/pricing/latest.json";
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

function isValid(r: unknown): r is ModelRegistry {
  const reg = r as ModelRegistry;
  return !!reg && typeof reg === "object" && typeof reg.schema_version === "number"
    && reg.schema_version >= 2 && !!reg.families && typeof reg.families === "object";
}

export interface RegistryClient {
  getRegistry(): Promise<ModelRegistry>;
  /** Resolve (provider, family) to the current model ID; non-active channels fall back to active. */
  resolve(provider: Provider, family: string, channel?: "active" | "stable" | "preview"): Promise<string>;
  /** Context window in tokens, or undefined if unknown. */
  contextWindow(modelId: string): Promise<number | undefined>;
  /** Full curated model-ID list for a provider (empty if unknown). */
  available(provider: Provider): Promise<string[]>;
  clearCache(): void;
}

export function createRegistryClient(opts: RegistryClientOptions = {}): RegistryClient {
  const envUrl =
    typeof process !== "undefined" ? process.env?.MODEL_REGISTRY_URL : undefined;
  const url = opts.url ?? envUrl ?? DEFAULT_URL;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  let memo: { data: ModelRegistry; ts: number } | null = null;

  async function getRegistry(): Promise<ModelRegistry> {
    if (memo && now() - memo.ts < ttlMs) return memo.data;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      const json = await res.json();
      if (!isValid(json)) throw new Error("registry schema invalid (need schema_version >= 2 with families)");
      memo = { data: json, ts: now() };
      return memo.data;
    } catch (err) {
      console.error("model-registry fetch failed; using cache/fallback:", err);
      if (memo) return memo.data;
      if (opts.fallback) return opts.fallback;
      throw new Error(`registry unavailable and no fallback configured: ${err}`);
    }
  }

  return {
    getRegistry,
    async resolve(provider, family, channel = "active") {
      const reg = await getRegistry();
      const families = reg.families[provider];
      if (!families || !(family in families)) {
        const known = families ? Object.keys(families).sort() : Object.keys(reg.families).sort();
        throw new Error(`no family ${provider}/${family} in registry (known: ${known.join(", ")})`);
      }
      if (channel !== "active") {
        const detail = reg.families_detail?.[provider]?.[family];
        if (detail?.[channel]) return detail[channel]!;
      }
      return families[family];
    },
    async contextWindow(modelId) {
      const reg = await getRegistry();
      return reg.capabilities?.[modelId]?.context_window;
    },
    async available(provider) {
      const reg = await getRegistry();
      return [...(reg.available[provider] ?? [])];
    },
    clearCache() {
      memo = null;
    },
  };
}

/**
 * Token-pricing feed (published daily by the same registry bucket).
 *
 * The document is the raw scrape of each provider's official pricing page:
 * `providers[provider].token_pricing_tables` is a list of `{section, columns, rows}`
 * tables whose row keys are the provider's own column headers (OpenAI and Anthropic
 * tables key rows by "Model"; Google's by "Metric"). A faithful capture, not a
 * normalized rate card — see `unit_note` in the document.
 */

export interface PricingTable {
  section: string;
  columns: string[];
  rows: Record<string, string>[];
}

export interface PricingProvider {
  name: string;
  token_pricing_tables: PricingTable[];
  [extra: string]: unknown; // source URLs, parser notes, table counts
}

export interface PricingDocument {
  fetched_at: string;
  currency: string;
  unit_note?: string;
  providers: Record<string, PricingProvider>;
}

export interface PricingClientOptions {
  /** Pricing URL. Default: MODEL_PRICING_URL env var, else the public ChameleonLabs URL. */
  url?: string;
  /** Last-known-good pricing document. Enables never-throw mode. */
  fallback?: PricingDocument;
  /** Cache TTL in ms. Default 1 hour. */
  ttlMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** A pricing row flattened out of its table, tagged with the table's section heading. */
export type PricingRow = Record<string, string> & { section: string };

function isValidPricing(d: unknown): d is PricingDocument {
  const doc = d as PricingDocument;
  return !!doc && typeof doc === "object" && typeof doc.fetched_at === "string"
    && !!doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers);
}

export interface PricingClient {
  getPricing(): Promise<PricingDocument>;
  /** All of a provider's pricing rows, each gaining a `section` key. Throws on unknown provider. */
  rows(provider: Provider): Promise<PricingRow[]>;
  clearCache(): void;
}

export function createPricingClient(opts: PricingClientOptions = {}): PricingClient {
  const envUrl =
    typeof process !== "undefined" ? process.env?.MODEL_PRICING_URL : undefined;
  const url = opts.url ?? envUrl ?? DEFAULT_PRICING_URL;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  let memo: { data: PricingDocument; ts: number } | null = null;

  async function getPricing(): Promise<PricingDocument> {
    if (memo && now() - memo.ts < ttlMs) return memo.data;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`pricing HTTP ${res.status}`);
      const json = await res.json();
      if (!isValidPricing(json)) throw new Error("pricing document invalid (need providers dict and fetched_at)");
      memo = { data: json, ts: now() };
      return memo.data;
    } catch (err) {
      console.error("model-pricing fetch failed; using cache/fallback:", err);
      if (memo) return memo.data;
      if (opts.fallback) return opts.fallback;
      throw new Error(`pricing unavailable and no fallback configured: ${err}`);
    }
  }

  return {
    getPricing,
    async rows(provider) {
      const doc = await getPricing();
      const entry = doc.providers[provider];
      if (!entry) {
        throw new Error(
          `no provider ${provider} in pricing document (known: ${Object.keys(doc.providers).sort().join(", ")})`,
        );
      }
      return (entry.token_pricing_tables ?? []).flatMap((table) =>
        table.rows.map((row) => ({ section: table.section, ...row })),
      );
    },
    clearCache() {
      memo = null;
    },
  };
}
