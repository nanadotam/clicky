Update: April 27, 2026.

Hi there! I'm Farza, the guy that made Clicky.

The existing codebase remains open source. Tinker with it, make it yours, start a company out of it, do whatever you want I don't mind. But, for all the new stuff I'm hacking on, gonna keep it private. To get the latest Clicky, you can go [here](https://www.heyclicky.com/).

I also tweeted about this [here](https://x.com/FarzaTV/status/2043402737828962489).

Go crazy with this repo!! It's an MIT license.

# Hi, this is Clicky.
It's an AI teacher that lives as a buddy next to your cursor. It can see your screen, talk to you, and even point at stuff. Kinda like having a real teacher next to you.

Download it [here](https://www.clicky.so/) for free.

Here's the [original tweet](https://x.com/FarzaTV/status/2041314633978659092) that kinda blew up for a demo for more context.

![Clicky — an ai buddy that lives on your mac](clicky-demo.gif)

This is the open-source version of Clicky for those that want to hack on it, build their own features, or just see how it works under the hood.

## Get started with Claude Code

The fastest way to get this running is with [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Once you get Claude running, paste this:

```
Hi Claude.

Clone https://github.com/farzaa/clicky.git into my current directory.

Then read the CLAUDE.md. I want to get Clicky running locally on my Mac.

Help me set up everything — the Cloudflare Worker with my own API keys, the proxy URLs, and getting it building in Xcode. Walk me through it.
```

That's it. It'll clone the repo, read the docs, and walk you through the whole setup. Once you're running you can just keep talking to it — build features, fix bugs, whatever. Go crazy.

## Manual setup

If you want to do it yourself, here's the deal.

### Prerequisites

- macOS 14.2+ (for ScreenCaptureKit)
- Xcode 15+
- Node.js 18+ (for the Cloudflare Worker)
- A [Cloudflare](https://cloudflare.com) account (free tier works)
- API keys for: [Anthropic](https://console.anthropic.com), [AssemblyAI](https://www.assemblyai.com), [ElevenLabs](https://elevenlabs.io)

### 1. Set up the Cloudflare Worker

The Worker is a tiny proxy that holds your API keys. The app talks to the Worker, the Worker talks to the APIs. This way your keys never ship in the app binary.

```bash
cd worker
npm install
```

Now add your secrets. Wrangler will prompt you to paste each one:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
```

For the ElevenLabs voice ID, open `wrangler.toml` and set it there (it's not sensitive):

```toml
[vars]
ELEVENLABS_VOICE_ID = "your-voice-id-here"
```

Deploy it:

```bash
npx wrangler deploy
```

It'll give you a URL like `https://your-worker-name.your-subdomain.workers.dev`. Copy that.

### 2. Run the Worker locally (for development)

If you want to test changes to the Worker without deploying:

```bash
cd worker
npx wrangler dev
```

This starts a local server (usually `http://localhost:8787`) that behaves exactly like the deployed Worker. You'll need to create a `.dev.vars` file in the `worker/` directory with your keys:

```
ANTHROPIC_API_KEY=sk-ant-...
ASSEMBLYAI_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```

Then update the proxy URLs in the Swift code to point to `http://localhost:8787` instead of the deployed Worker URL while developing. Grep for `clicky-proxy` to find them all.

### 3. Update the proxy URLs in the app

The app has the Worker URL hardcoded in a few places. Search for `your-worker-name.your-subdomain.workers.dev` and replace it with your Worker URL:

```bash
grep -r "clicky-proxy" leanring-buddy/
```

You'll find it in:
- `CompanionManager.swift` — Claude chat + ElevenLabs TTS
- `AssemblyAIStreamingTranscriptionProvider.swift` — AssemblyAI token endpoint

### 4. Open in Xcode and run

```bash
open leanring-buddy.xcodeproj
```

In Xcode:
1. Select the `leanring-buddy` scheme (yes, the typo is intentional, long story)
2. Set your signing team under Signing & Capabilities
3. Hit **Cmd + R** to build and run

The app will appear in your menu bar (not the dock). Click the icon to open the panel, grant the permissions it asks for, and you're good.

### Permissions the app needs

- **Microphone** — for push-to-talk voice capture
- **Accessibility** — for the global keyboard shortcut (Control + Option)
- **Screen Recording** — for taking screenshots when you use the hotkey
- **Screen Content** — for ScreenCaptureKit access

## Running fully local (no cloud APIs)

This fork adds a local-first path: the Worker still speaks the same
Anthropic/ElevenLabs dialects on the outside (so the Swift app's networking
code is untouched), but internally it can translate and forward to models
running on your own Mac instead of any cloud API. No API keys, no per-token
billing, nothing leaves your machine.

**What's local right now:**

| Piece | Cloud original | Local replacement |
|---|---|---|
| Chat + vision + pointing | Claude via Anthropic | [Ollama](https://ollama.com) — any local model whose name doesn't start with `claude-` is routed to Ollama's `/api/chat` instead. Tested with `qwen2.5vl:7b` and `llama3.2-vision:11b` (both vision-capable, needed for the screen-pointing feature). |
| Text-to-speech | ElevenLabs | [Kokoro-82M](https://huggingface.co/mlx-community/Kokoro-82M-4bit) via [mlx-audio](https://github.com/Blaizzy/mlx-audio)'s OpenAI-compatible `/v1/audio/speech` server, running on Apple Silicon via MLX. |
| Speech-to-text | AssemblyAI | Apple's on-device Speech framework — already built into this codebase (`AppleSpeechTranscriptionProvider.swift`) as a fallback provider, just needs selecting. |

### Setup

**1. Ollama** (chat/vision) — install from [ollama.com](https://ollama.com), then:
```bash
ollama pull qwen2.5vl:7b
ollama pull llama3.2-vision:11b   # optional second option
```
Make sure `ollama serve` is running (the menu-bar app does this automatically).

**2. Kokoro TTS** — needs Python 3.11 specifically; `misaki[en]`'s dependency
chain (spaCy → thinc → blis) has no prebuilt wheel yet for 3.13 on macOS arm64:
```bash
python3.11 -m venv .venv-tts
source .venv-tts/bin/activate
pip install "mlx-audio[server]" "misaki[en]"
python3 -m mlx_audio.server --host 127.0.0.1 --port 8000
```

**3. Worker, running locally instead of deployed to Cloudflare:**
```bash
cd worker
npm install
npx wrangler telemetry disable   # skips an interactive first-run prompt
cp .dev.vars.example .dev.vars   # then fill in LOCAL_TTS=true etc — see below
npx wrangler dev --port 8787
```

Your `worker/.dev.vars` (gitignored, never committed) needs:
```
ANTHROPIC_API_KEY=
ASSEMBLYAI_API_KEY=
ELEVENLABS_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
LOCAL_TTS=true
KOKORO_BASE_URL=http://localhost:8000
KOKORO_VOICE=af_heart
```
(The three cloud keys can stay blank — they're only read if you deliberately
select a `claude-*` model or set `LOCAL_TTS=false`.)

**4. Swift app** — `CompanionManager.swift`'s `workerBaseURL` already points
at `http://localhost:8787` and `selectedModel` already defaults to
`"qwen2.5vl:7b"` in this fork. Open in Xcode and run as usual (see below).

### Why this works without touching the Swift networking code

`ClaudeAPI.swift` and `ElevenLabsTTSClient.swift` only know how to speak one
dialect each (Anthropic's SSE format, ElevenLabs' request shape). Rather than
teach the Swift app two dialects per capability, all the translation lives
in one place — `worker/src/index.ts` — which is the only thing that knows
both sides. `/chat` translates Anthropic's request/SSE shape to/from
Ollama's `/api/chat` shape; `/tts` translates ElevenLabs' `{text, model_id,
voice_settings}` to Kokoro's OpenAI-compatible `{model, input, voice}` (and
Kokoro conveniently also returns MP3, so no re-encoding is needed either).
The Swift app genuinely cannot tell the difference.

## Architecture

If you want the full technical breakdown, read `CLAUDE.md`. But here's the short version:

**Menu bar app** (no dock icon) with two `NSPanel` windows — one for the control panel dropdown, one for the full-screen transparent cursor overlay. Push-to-talk streams audio over a websocket to AssemblyAI, sends the transcript + screenshot to Claude via streaming SSE, and plays the response through ElevenLabs TTS. Claude can embed `[POINT:x,y:label:screenN]` tags in its responses to make the cursor fly to specific UI elements across multiple monitors. All three APIs are proxied through a Cloudflare Worker.

## Project structure

```
leanring-buddy/          # Swift source (yes, the typo stays)
  CompanionManager.swift    # Central state machine
  CompanionPanelView.swift  # Menu bar panel UI
  ClaudeAPI.swift           # Claude streaming client
  ElevenLabsTTSClient.swift # Text-to-speech playback
  OverlayWindow.swift       # Blue cursor overlay
  AssemblyAI*.swift         # Real-time transcription
  BuddyDictation*.swift     # Push-to-talk pipeline
worker/                  # Cloudflare Worker proxy
  src/index.ts              # Three routes: /chat, /tts, /transcribe-token
CLAUDE.md                # Full architecture doc (agents read this)
```

## Contributing

PRs welcome. If you're using Claude Code, it already knows the codebase — just tell it what you want to build and point it at `CLAUDE.md`.

Got feedback? DM me on X [@farzatv](https://x.com/farzatv).
