# Briefing: PersonaPlex / PersonaPlex-MLX, for continuing this conversation elsewhere

Written as a handoff so a new AI agent session has full context without re-deriving it.
Author's intent: the user wants to ask a lot more questions specifically about
PersonaPlex-MLX and wants this briefing as the starting context for that conversation.

## Background: why PersonaPlex came up at all

The user is running a fork of [Clicky](https://github.com/farzaa/clicky)
(their fork: https://github.com/nanadotam/clicky, cloned locally at
`/Users/nanaamoako/Developer/clicky`) — a macOS menu-bar companion app that
watches your screen (ScreenCaptureKit), listens via push-to-talk, and talks
back with an AI voice, pointing a cursor at UI elements Claude references.
Stock Clicky is 100% cloud: Claude (chat+vision) via a Cloudflare Worker
proxy, AssemblyAI (speech-to-text), ElevenLabs (text-to-speech).

The user wants to run everything **locally** — no cloud calls — using local
models they already have via Ollama, plus whatever else fits. This is being
pursued as both (a) a genuinely useful tool and (b) explicitly a learning
exercise: the user is relearning Java/Spring Boot for a separate project
(SoroSend) and wants a screen-aware AI tutor; Clicky's architecture (sees
your screen, talks, points at things) is a good fit for that vision, but the
Clicky work itself is Swift/TypeScript, not Java.

### What's already been built (context, not the focus of this doc)

- **`/chat` (LLM) → done and tested.** Rewrote the Worker (`worker/src/index.ts`)
  to act as a translation adapter: any request whose `model` field doesn't
  start with `"claude-"` gets routed to a local Ollama model instead of
  Anthropic. Ollama's response (newline-delimited JSON) gets translated back
  into Anthropic-style SSE (`content_block_delta` events) so the existing
  Swift client (`ClaudeAPI.swift`) needs zero changes — it has no idea it's
  talking to a local model. Tested end-to-end (non-streaming confirmed
  working; streaming was mid-test, unconfirmed, when this conversation moved
  on to other things).
- **Local vision models via Ollama**: `qwen2.5vl:7b` (already had it) and
  `llama3.2-vision:11b` (pulled during this session) — these are what will
  eventually replace Claude for the screen-vision/pointing feature.
- **`/tts` (voice) → in progress, NOT PersonaPlex.** After ruling out
  PersonaPlex (see below), landed on **Kokoro-82M** via the
  [`mlx-audio`](https://github.com/Blaizzy/mlx-audio) library — a proper
  text-to-speech model (exact text in, matching audio out) that exposes an
  OpenAI-compatible `/v1/audio/speech` REST endpoint. Installed in a
  dedicated Python 3.11 venv at `/Users/nanaamoako/Developer/clicky/.venv-tts`
  (had to use 3.11, not the system's 3.13 — a dependency of Kokoro's
  `misaki[en]` text-processing package, `blis`, has no prebuilt wheel yet for
  3.13 on macOS arm64). Verified working: generated and played back real
  audio (`af_heart` voice, 6.4s clip). Not yet wired into the Worker's `/tts`
  route or into `CompanionManager.swift` — that's the next step, following
  the same "adapter" pattern used for `/chat`.
- **STT → not yet flipped**, but trivial: `AppleSpeechTranscriptionProvider.swift`
  already exists in the codebase as a local, on-device fallback. Just needs
  the `VoiceTranscriptionProvider` key in Info.plist switched to it.

## The two repos the user asked about

1. **https://github.com/NVIDIA/personaplex** — the official NVIDIA repo.
2. **https://github.com/mu-hashmi/personaplex-mlx** — a community MLX port
   for Apple Silicon (unofficial, third-party).

## What PersonaPlex actually is (verified by reading the code, not just the README)

**PersonaPlex is a real-time, full-duplex speech-to-speech conversational
model**, built on Kyutai's Moshi architecture, ~7B params, gated on
HuggingFace (`nvidia/personaplex-7b-v1`, requires accepting NVIDIA's license
+ an `HF_TOKEN`). Paper: https://arxiv.org/abs/2602.06053.

Key facts, confirmed by reading `moshi/moshi/offline.py` in the NVIDIA repo
directly (not inferred from the README):

- It is **not** a text-to-speech model. It does not accept a script and read
  it aloud.
- It requires a **paired input WAV** of user audio to drive its response —
  this is inherent to the offline inference script's design (`--input-wav`
  is a required-in-practice argument for meaningful output; the model
  autoregressively generates response audio *frame-by-frame in lockstep with
  the input audio stream*, not from a standalone text prompt).
- Its `--text-prompt` / `--voice-prompt` arguments are a **persona/role
  system description** (e.g. `"You enjoy having a good conversation."`), not
  spoken content. The model decides what to say on its own, in character,
  reacting live to the input audio. There is no way to hand it an exact
  sentence and get that exact sentence spoken back.
- It's genuinely full-duplex: continuous listening, can interrupt/overlap,
  not push-to-talk/turn-based.
- 16 built-in voice IDs (`NATF0`–`NATF3`, `NATM0`–`NATM3`, `VARF0`–`VARF4`,
  `VARM0`–`VARM4`).
- Runs as a live server (`python -m moshi.server`, WebSocket-based, port
  8998), not a stateless request/response API.

### The MLX port (`mu-hashmi/personaplex-mlx`)

Confirms it's genuinely runnable on Apple Silicon:

- Requirements: Apple Silicon Mac, Python 3.12, same gated HF model + token.
- Quantization support (`-q 4` = 4-bit), which brings the ~7B model down to
  roughly 3.5–4GB — very feasible given the user's Mac has 24GB RAM.
- Three modes: `personaplex_mlx.local` (terminal), `personaplex_mlx.local_web`
  (browser UI at `localhost:8998`, recommended first), `personaplex_mlx.offline`
  (WAV-in/WAV-out batch mode).
- Explicitly says: **no echo cancellation built in** — must use headphones,
  or the mic will pick up the model's own speech output and corrupt the
  conversation.

## Why it was ruled out for the `/tts` role in Clicky

Clicky's `/tts` route needs: take Claude's (or the local LLM's) exact
response text → get back audio saying *that exact text*. PersonaPlex can't
do this — it generates its own dialogue, it doesn't take dictation. Using it
would mean Clicky's actual reasoning (Claude/qwen/llama) and the "voice"
would be two independent agents improvising separately, not one pipeline
speaking a chosen response. This is an architectural mismatch, not a
difficulty/resource problem — even with unlimited compute, PersonaPlex
still couldn't fill this role as designed.

## What PersonaPlex actually *would* be good for

Not a TTS swap — a **separate, standalone real-time voice conversation
partner**. If run, the user would get: an AI you can literally have a live
phone-call-style conversation with, in a chosen persona/voice, fully
offline after the initial model download. This is a different, bigger,
separate project from "give Clicky a better voice" — more like "replace
Clicky's whole turn-based push-to-talk interaction model with a live duplex
conversation," which is a legitimate and interesting direction on its own,
just not something explored or decided on yet. This is likely the jumping-off
point for the user's follow-up questions.

## Open threads / where a follow-up conversation would likely go

- Deeper dive on Moshi architecture (what PersonaPlex is built on) and how
  full-duplex speech models differ architecturally from turn-based
  chat+TTS pipelines.
- Whether/how PersonaPlex could be adapted (fine-tuned? conditioned
  differently?) to actually speak specific text rather than improvise — i.e.
  is the "must generate its own words" limitation fundamental to the
  architecture, or a product-level choice in how the reference
  server/offline scripts expose it.
- Concrete steps to actually install and run `personaplex-mlx` locally (HF
  license acceptance, token setup, `pip install -e .`, first-run model
  download size/time, `-q 4` quantization quality tradeoffs).
- Whether it's worth pursuing as a Clicky replacement/parallel mode (fully
  duplex conversation) vs. just as a separate fun thing to try.
- Voice quality/latency comparisons vs. Kokoro (which is what's actually
  wired in for the `/tts` role now) — these serve completely different
  purposes so aren't really competitors, but the user may want that
  distinction reinforced.

## Repo/file map for reference

- Clicky fork, cloned locally: `/Users/nanaamoako/Developer/clicky`
- Router/adapter: `/Users/nanaamoako/Developer/clicky/worker/src/index.ts`
- Swift chat client (unmodified, works with local models via the adapter):
  `/Users/nanaamoako/Developer/clicky/leanring-buddy/ClaudeAPI.swift`
- Orchestrator / model picker:
  `/Users/nanaamoako/Developer/clicky/leanring-buddy/CompanionManager.swift`
- TTS venv: `/Users/nanaamoako/Developer/clicky/.venv-tts` (Python 3.11,
  `mlx-audio` + `misaki[en]`, Kokoro-82M-4bit cached)
- NVIDIA PersonaPlex: https://github.com/NVIDIA/personaplex
- MLX port: https://github.com/mu-hashmi/personaplex-mlx
