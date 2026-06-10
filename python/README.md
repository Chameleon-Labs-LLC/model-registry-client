# chameleonlabs-model-registry (Python)

Resolve current LLM model IDs at runtime from the ChameleonLabs public model registry
(or your own). Stdlib only.

```bash
pip install "chameleonlabs-model-registry @ git+https://github.com/Chameleon-Labs-LLC/model-registry-client#subdirectory=python"
```

```python
from model_registry import resolve, context_window

model_id = resolve("anthropic", "opus")   # -> e.g. "claude-opus-4-8"
window = context_window(model_id)         # -> 200000
```

Daily token pricing (raw provider pricing tables) from the same bucket:

```python
from model_registry import get_pricing, pricing_rows

rows = pricing_rows("anthropic")          # rows tagged with their table "section"
```

Prefer zero dependencies? Vendor `src/model_registry/client.py` as a single file.

Full docs (registry schema, fallback pattern, TypeScript client): see the
[repo README](https://github.com/Chameleon-Labs-LLC/model-registry-client).
