# Project handoff: local-first Clicky pivot

Written so you (or a fresh AI agent session) can pick this up cold, anywhere,
without re-deriving anything. Reflects state as of the `46538f8` commit on
`main` in `nanadotam/clicky` (pushed to GitHub). **The app has now actually
been built and run for the first time** — see "Status: it's alive" below,
this supersedes the "never been run" note from the previous version of this
doc.

## The goal

Take Farza's [Clicky](https://github.com/farzaa/clicky) (a macOS menu-bar
companion app that watches your screen, listens via push-to-talk, and talks
back with an AI voice, pointing a cursor at things it references) and make
it run **entirely locally** — no cloud API keys, no per-token billing —
using local models via Ollama, plus whatever else fits, while keeping the
Swift app's networking code untouched wherever possible.

Secondary goal, stated explicitly by the user: this is also a learning
exercise. A separate project (SoroSend, unrelated Java/Spring Boot work) is
where the user is relearning Java from scratch; Clicky's "AI buddy that sees
your screen and explains things" shape is the eventual vision for a
screen-aware tutor, but the Clicky build itself is Swift/TypeScript, done in
full (not scaffolded) since it's tooling, not the thing being learned.

## Repo state

- Fork: `https://github.com/nanadotam/clicky` (upstream: `farzaa/clicky`)
- Cloned locally at `/Users/nanaamoako/Developer/clicky`
- Latest commits on `main` (oldest to newest):
  - `28080c5` — "Add local-first mode: Ollama chat/vision, Kokoro TTS, Apple Speech STT"
  - `b93dc17` — "Switch chat/vision to gemma4:cloud with local fallback"
  - `fb3c9d6` — "Add full project handoff doc for continuing elsewhere" (the previous version of this file)
  - `7900582` — "Harden Worker error handling: no more silent stream crashes"
  - `46538f8` — "Wire up status messaging and add local-model picker"
- All pushed to GitHub already.

## Status: it's alive

The app has been built and run for real (not just tested by hitting the
Worker with curl/Python) as of this session. Getting there required an
unrelated detour: after updating Xcode, `open -a Xcode` and `xed` both
failed with Launch Services errors (`Unable to find application named
'Xcode'`, then `_LSOpenURLsWithCompletionHandler failed with error -10664`)
even though `/Applications/Xcode.app` was present and correctly signed
(verified via `codesign`/`spctl` — not a corrupted install). Root cause:
Launch Services' app registry hadn't picked up the freshly-updated Xcode.
Fix that actually worked:
1. `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -r -domain local -domain system -domain user` (rebuild the registry — the old `-kill` flag people reference online has been removed in current macOS)
2. Launch the binary directly, bypassing Launch Services entirely:
   `/Applications/Xcode.app/Contents/MacOS/Xcode &`
3. Once Xcode is running as a process, open the actual project into that
   running instance via AppleScript (also bypasses Launch Services, since
   it addresses the already-running app directly):
   `osascript -e 'tell application "Xcode" to open "/Users/nanaamoako/Developer/clicky/leanring-buddy.xcodeproj"'`
   then `osascript -e 'tell application "Xcode" to activate'` to bring it
   forward.

None of this touched `xcodebuild` or any TCC-sensitive path — it's purely
Launch Services plumbing, so the "don't run xcodebuild" rule was never at
risk of being violated by this fix.

**Real evidence the running app is actually using the local pipeline**: the
Worker's log shows `HEAD / 405 Method Not Allowed` entries — that's not
something any test script sent; it's specifically `ClaudeAPI.swift`'s
TLS-warmup ping (a background `HEAD` request fired once per process
lifetime to pre-establish the connection). Seeing that in the log, next to
real `/chat`/`/tts` 200s, is concrete proof the compiled Swift app is
talking through the local router, not the deployed cloud Worker.

## Architecture: the "adapter" pattern

The Swift app's networking clients (`ClaudeAPI.swift`,
`ElevenLabsTTSClient.swift`) were **never modified**. Each only knows how to
speak one cloud dialect (Anthropic's SSE format; ElevenLabs' request shape).
All translation lives in exactly one place: `worker/src/index.ts`, a
Cloudflare Worker run locally via `wrangler dev` instead of deployed. This
is the only thing that knows both dialects on each route:

- **`/chat`**: any request whose `model` field doesn't start with `"claude-"`
  gets translated from Anthropic's request/SSE shape into Ollama's
  `/api/chat` shape, forwarded to the Ollama daemon on this machine, and
  translated back. Works identically whether the model is a local tag
  (`llama3.2-vision:11b`) or an Ollama Cloud tag (`gemma4:cloud`) — Ollama
  itself handles that distinction; the Worker doesn't need to know.
- **`/tts`**: when `LOCAL_TTS=true`, translates ElevenLabs' `{text, model_id,
  voice_settings}` shape into Kokoro's OpenAI-compatible `{model, input,
  voice}` shape, forwards to a local `mlx_audio.server` instance. Kokoro
  conveniently also returns MP3 (same as ElevenLabs), so no re-encoding.

## What's wired and verified working (tested live, not just written)

| Piece | What | Status |
|---|---|---|
| Chat + vision, primary | `gemma4:cloud` (Ollama Cloud, free "Low Usage" tier) | ✅ tested: 9.2s, correct on-screen text reading |
| Chat + vision, fallback | `llama3.2-vision:11b` (fully local) | ✅ tested: triggers automatically on 403/429 from the primary |
| Fallback trigger logic | `handleOllamaChat` in `worker/src/index.ts` | ✅ tested end-to-end with a forced-failure case (`qwen3.5:cloud`, known to 403) |
| Text-to-speech | Kokoro-82M via `mlx-audio`'s `/v1/audio/speech` | ✅ tested: real audio generated and played back |
| Speech-to-text | Apple's on-device Speech framework | Flipped in `Info.plist` (`VoiceTranscriptionProvider` → `"apple"`) — this provider already existed in the codebase (`AppleSpeechTranscriptionProvider.swift`), just needed selecting. |
| `workerBaseURL` | Points at local `wrangler dev` | `CompanionManager.swift`, `http://localhost:8787` |
| `selectedModel` default | `"gemma4:cloud"` | `CompanionManager.swift` |
| Status messaging | Real phase text ("Capturing your screen…", "Asking gemma4:cloud…") instead of a bare spinner | `CompanionManager.swift` now instantiates and drives `CompanionResponseOverlayManager` (from `CompanionResponseOverlay.swift`) — this class existed in the codebase already but was **dead code**, never instantiated anywhere, before this session |
| Connection-error fallback | Distinguishes real connectivity failures (`URLError` — Worker/Ollama unreachable) from other errors, speaks + shows an appropriate message | Replaced `speakCreditsErrorFallback()` (a stale "I'm out of credits, DM Farza" message left over from the cloud-only era) with `speakConnectionErrorFallback(_:)` |
| Model picker UI | Second row in the menu-bar panel for Gemma (cloud) / Llama (local), alongside the existing Sonnet/Opus row | `CompanionPanelView.swift`'s `modelPickerRow` |
| Worker error hardening | Malformed streaming JSON no longer crashes the whole response mid-stream; malformed `/chat` requests get a clean 400 instead of an opaque 500 | `worker/src/index.ts` — see `7900582` |

## What's NOT done yet

- **STT (Apple Speech) still hasn't been specifically confirmed working** —
  the app is running now, but nobody has explicitly verified a voice
  transcription round-trip through the Apple Speech provider yet (as
  opposed to the chat/vision and TTS paths, which have direct log evidence).
- **The status bubble and new model picker are freshly wired but not yet
  visually confirmed in the running app** — written and committed this
  session, logic checked by careful read-through (no `xcodebuild`/`swiftc`
  compile-check was possible outside Xcode itself, since the project's SPM
  dependencies — PostHog, Sparkle, plcrashreporter — only resolve inside
  Xcode's own build context), but nobody has watched it render live yet.

## How to actually launch it (steps only a human can do — see below for why)

1. Make sure the local services are running:
   ```bash
   # Ollama (usually already running as the menu-bar app)
   ollama serve

   # Kokoro TTS server
   cd /Users/nanaamoako/Developer/clicky
   source .venv-tts/bin/activate
   python3 -m mlx_audio.server --host 127.0.0.1 --port 8000

   # Worker (local, not deployed)
   cd /Users/nanaamoako/Developer/clicky/worker
   npx wrangler dev --port 8787
   ```
2. `open leanring-buddy.xcodeproj` (if this fails with a Launch Services
   error like `Unable to find application named 'Xcode'`, see "Status: it's
   alive" above for the actual working fix — it's a Launch Services registry
   issue, not a project problem).
3. In Xcode: select the `leanring-buddy` scheme, set your signing team under
   Signing & Capabilities, hit **Cmd+R**.
4. Grant the mic / screen recording / accessibility prompts as they appear.

### Why an AI agent can't do step 2–4 for you

- Clicky's own `CLAUDE.md` explicitly forbids running `xcodebuild` from the
  terminal — it can invalidate the **TCC** (Transparency, Consent, and
  Control — macOS's permission-grant subsystem, tracked in
  `~/Library/Application Support/com.apple.TCC/TCC.db`) identity match, since
  a raw terminal build can produce a different code-signing identity than
  Xcode's own Cmd+R flow, making macOS treat it as a brand-new unrecognized
  app and re-prompt for every permission.
- Even with a perfect build, the mic/screen-recording/accessibility "Allow"
  dialogs themselves cannot be scripted or clicked by an automated process —
  this is an intentional macOS security boundary (specifically designed to
  stop exactly that: software silently granting itself camera/mic access).
  There's no configuration flag or "I give permission" that changes this;
  it's not a policy choice, it's how the OS works.

## Rejected approaches (with reasons, so they don't get re-explored blindly)

- **PersonaPlex / PersonaPlex-MLX** (NVIDIA's full-duplex speech-to-speech
  model) was investigated for the TTS role and ruled out — full details in
  `docs/personaplex-briefing.md`. Short version: it doesn't accept a script
  to read aloud, it generates its own dialogue in response to input audio.
  Can't fill the "speak this exact response text" role ElevenLabs/Kokoro
  fill. Still an interesting *separate* full-duplex-conversation project,
  just not a TTS swap.
- **Smaller image resizes for local vision** (960px down to 384px) were
  benchmarked and rejected — full details in
  `docs/vision-model-benchmark.md`. Below ~960px, models stop admitting they
  can't read small text and start confidently inventing plausible-sounding
  wrong answers instead. Not used.
- **`qwen3.5:cloud`** rejected as a primary/fallback candidate — requires an
  Ollama subscription beyond the free tier (confirmed via a live 403).

## Local environment specifics (so a fresh session doesn't have to rediscover these)

- **Kokoro/mlx-audio needs Python 3.11, not the system's 3.13.** A
  dependency of `misaki[en]` (Kokoro's text-processing package) — `blis`,
  itself a dependency of spaCy/thinc — has no prebuilt wheel yet for Python
  3.13 on macOS arm64 and fails compiling from source. The venv at
  `/Users/nanaamoako/Developer/clicky/.venv-tts` was built with
  `/opt/homebrew/bin/python3.11` specifically.
- **`npx wrangler telemetry disable`** was run once to stop Wrangler's
  first-run interactive telemetry prompt from hanging non-interactive shell
  sessions.
- Local models already pulled via Ollama: `qwen2.5vl:7b`,
  `llama3.2-vision:11b`, plus your pre-existing collection (deepseek-r1,
  qwen3.5, llava:7b, etc. — unrelated to this project).
- Ollama Cloud: signed in as `nanaamoako202`. `gemma4:cloud` and
  `qwen3.5:cloud` manifest tags pulled (these are just tiny pointer
  manifests, not full weights — cloud models still execute on Ollama's
  infrastructure).

## Config reference

`worker/.dev.vars` (gitignored, never committed — recreate from
`worker/.dev.vars.example`):
```
ANTHROPIC_API_KEY=
ASSEMBLYAI_API_KEY=
ELEVENLABS_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
FALLBACK_MODEL=llama3.2-vision:11b
LOCAL_TTS=true
KOKORO_BASE_URL=http://localhost:8000
KOKORO_VOICE=af_heart
```

## Related but separate: SoroSend study questions

Not part of this repo, but produced in the same session and worth knowing
about: `/Users/nanaamoako/Developer/altpay-demo/SoroSendApp/docs/study-questions-auth-credentials.md`
(+ a `.pdf` version) — 24 study questions pulled from real code in the
*other* project (SoroSend, the Java/Spring Boot learning project mentioned
in "The goal" above), covering the Spring Security filter chain, JWT design,
OAuth2 login flow, entity mapping, and the still-unfinished credentials
encryption piece. Meant as material for whatever Java tutor eventually gets
built on top of this local pipeline.

## Open ideas, not started

- **Ebook/article reader mode**: feed arbitrary text (PDF, article) to the
  local Kokoro server directly for spoken audio — doesn't need Clicky or
  the Worker at all, just a standalone script hitting
  `http://localhost:8000/v1/audio/speech`. Floated by the user, not built.
- Untried vision models worth a look if accuracy matters more than speed:
  `deepseek-ocr` (3b, OCR-specialized), `qwen3-vl` (newer than qwen2.5vl),
  `minicpm-v4.5` (8b).
