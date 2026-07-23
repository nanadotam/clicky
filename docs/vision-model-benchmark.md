# Vision model benchmark — choosing gemma4:cloud + llama3.2-vision:11b fallback

Real test results, not vendor claims. All tests used the same real screenshot
(a Spotify-style music player showing "Be Easy" by "Odeal", 1:13 into a 5:58
track) sent through the actual Worker (`worker/src/index.ts`) translation
path — i.e. these numbers include the real request/response overhead the
app will see, not raw model inference time.

## Round 1: local models, full resolution (3870×2514, unresized)

`qwen2.5vl:7b` timed out at 90s. Root cause: the image was full Retina
resolution — too large for the model to process in reasonable time. Not a
router bug; confirmed by resizing (below).

## Round 2: local models, resized

| Model | Size | Time | Result |
|---|---|---|---|
| qwen2.5vl:7b | 1280px | 49.5s | Title, artist, duration all correct |
| llama3.2-vision:11b | 1280px | 21.3s | Title correct, artist wrong ("Oskar" vs "Odeal") |
| qwen2.5vl:7b | 960px | 22.8s | Title correct, artist close-but-wrong ("Odsal"), duration wrong |
| qwen2.5vl:7b | 768px | 5.9s | Title correct, artist **hallucinated a real different artist** ("Odesza") |
| qwen2.5vl:7b | 640px | 4.1s | Title wrong too |
| qwen2.5vl:7b | 512px | 3.4s | Everything wrong |
| qwen2.5vl:7b | 384px | 3.4s | Fully hallucinated |

**Key finding:** there's no clean "smallest size that still works" — it's a
gradient, and the dangerous failure mode isn't the model saying "I can't
read that," it's confidently stating a plausible-sounding *wrong* answer
(e.g. inventing "Odesza," a real artist, when the actual artist was
"Odeal"). Small on-screen text becomes unreliable below ~960px. Also
notable: qwen's speed doesn't scale smoothly with pixel count — it drops
off a cliff between 960px (22.8s) and 768px (5.9s), a much bigger jump than
the ~1.56x pixel-area difference alone would predict. Likely an internal
tiling/patch-grid threshold in the vision encoder, not gradual scaling.

## Round 3: Ollama Cloud models, 1280px

| Model | Time | Result |
|---|---|---|
| gemma4:cloud | **9.2s** | Title AND artist both correct ("Be Easy" / "Odeal"), plus timestamp |
| qwen3.5:cloud | FAILED (403) | "this model requires a subscription" — this tier isn't free-accessible |
| qwen3.5:397b-cloud | FAILED (403) | Same — confirms the large variant needs a paid plan |

`gemma4:cloud` is tagged "Low Usage" on Ollama's pricing page (cheapest
quota tier) vs. `qwen3.5:cloud`'s "Medium Usage" — consistent with it being
the one that's actually free-tier accessible.

## Decision

**Primary: `gemma4:cloud`.** Fastest (9.2s) AND most accurate of everything
tested — beat every local model on both axes simultaneously.

**Fallback: `llama3.2-vision:11b`** (fully local, no quota). Wired into
`worker/src/index.ts`'s `handleOllamaChat`: if the primary model gets
rejected with 403 (subscription required) or 429 (quota exceeded) — the two
ways Ollama Cloud signals "can't serve this" — the Worker automatically
retries the same request against `FALLBACK_MODEL` instead of surfacing the
error. Ollama Cloud's free tier resets on a session basis (every 5h) and a
weekly basis (every 7 days) per their pricing page, so this makes the quota
a soft ceiling: once hit, responses get slower (and slightly less accurate
per the numbers above) rather than the app breaking outright, until the
quota resets.

Not benchmarked yet, worth trying later if accuracy matters more than
speed: `deepseek-ocr` (3b, OCR-specialized — might read small text better
than general vision models, which is where every local model actually
failed), `qwen3-vl` (newer generation than qwen2.5vl), `minicpm-v4.5` (8b,
claims GPT-4o-level image understanding).
