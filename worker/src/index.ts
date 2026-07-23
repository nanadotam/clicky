/**
 * Clicky Proxy Worker
 *
 * Proxies requests to Claude and ElevenLabs APIs so the app never
 * ships with raw API keys. Keys are stored as Cloudflare secrets.
 *
 * Routes:
 *   POST /chat  → Anthropic Messages API (streaming), OR a local Ollama
 *                 model — see handleChat's routing rule below
 *   POST /tts   → ElevenLabs TTS API, OR a local Kokoro server — see
 *                 handleTTS's routing rule below
 *
 * Local-model routing: the Swift app (ClaudeAPI.swift, ElevenLabsTTSClient.swift)
 * only ever knows how to send its one cloud-shaped request and parse the
 * matching cloud-shaped response. It has no idea a local model exists. This
 * Worker is the ONLY place that knows both dialects on each route — it's the
 * adapter. For /chat: when the request's `model` field isn't a Claude model,
 * translate to Ollama's /api/chat shape and translate Ollama's response back
 * to Anthropic-style SSE. For /tts: when LOCAL_TTS is set, translate
 * ElevenLabs' {text, model_id, voice_settings} shape to Kokoro's OpenAI-
 * compatible /v1/audio/speech shape and pass its MP3 bytes straight through
 * (same audio/mpeg format ElevenLabs returns, so no re-encoding needed).
 * Neither Swift client's code ever has to change.
 */

interface Env {
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  ASSEMBLYAI_API_KEY: string;
  /** e.g. "http://localhost:11434" — where the Ollama daemon is listening. */
  OLLAMA_BASE_URL?: string;
  /** "true" to route /tts to the local Kokoro server instead of ElevenLabs. */
  LOCAL_TTS?: string;
  /** e.g. "http://localhost:8000" — where `mlx_audio.server` is listening. */
  KOKORO_BASE_URL?: string;
  /** Kokoro voice id, e.g. "af_heart". See mlx-audio's voice list. */
  KOKORO_VOICE?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      if (url.pathname === "/chat") {
        return await handleChat(request, env);
      }

      if (url.pathname === "/tts") {
        return await handleTTS(request, env);
      }

      if (url.pathname === "/transcribe-token") {
        return await handleTranscribeToken(env);
      }
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  const anthropicRequest = JSON.parse(bodyText) as AnthropicChatRequest;

  // Routing rule: any model name that isn't a Claude model is treated as a
  // local Ollama model tag (e.g. "qwen2.5vl:7b", "llama3.2-vision:11b").
  // Anthropic's own model names all start with "claude-", so this needs no
  // separate allow-list — pulling a new Ollama model later just works.
  if (!anthropicRequest.model.startsWith("claude-")) {
    return handleOllamaChat(anthropicRequest, env);
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: bodyText,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/chat] Anthropic API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

// --- Anthropic <-> Ollama translation -------------------------------------
//
// These types describe only the fields ClaudeAPI.swift actually sends/reads —
// not the full Anthropic or Ollama API surface.

interface AnthropicContentBlock {
  type: "text" | "image";
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicChatRequest {
  model: string;
  max_tokens: number;
  stream?: boolean;
  system?: string;
  messages: AnthropicMessage[];
}

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

/**
 * Flattens one Anthropic message into Ollama's shape: Ollama wants a single
 * text string per message plus a separate `images` array of bare base64
 * strings (no "data:" prefix, no media_type — Ollama sniffs the format
 * itself), whereas Anthropic interleaves typed text/image content blocks.
 */
function toOllamaMessage(message: AnthropicMessage): OllamaMessage {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }

  const textParts: string[] = [];
  const images: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "image" && block.source) {
      images.push(block.source.data);
    }
  }

  return {
    role: message.role,
    content: textParts.join("\n"),
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * Handles /chat requests whose model is a local Ollama tag. Translates the
 * Anthropic-shaped request into Ollama's /api/chat format, forwards it to
 * the Ollama daemon running on this machine, and — for streaming requests —
 * re-emits Ollama's response as Anthropic-style SSE `content_block_delta`
 * events so ClaudeAPI.swift's existing parser (built for real Claude) can
 * read it without any changes.
 */
async function handleOllamaChat(anthropicRequest: AnthropicChatRequest, env: Env): Promise<Response> {
  const ollamaBaseURL = env.OLLAMA_BASE_URL || "http://localhost:11434";
  const isStreaming = anthropicRequest.stream ?? false;

  const ollamaMessages: OllamaMessage[] = [];
  if (anthropicRequest.system) {
    ollamaMessages.push({ role: "system", content: anthropicRequest.system });
  }
  ollamaMessages.push(...anthropicRequest.messages.map(toOllamaMessage));

  const ollamaResponse = await fetch(`${ollamaBaseURL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: anthropicRequest.model,
      messages: ollamaMessages,
      stream: isStreaming,
    }),
  });

  if (!ollamaResponse.ok) {
    const errorBody = await ollamaResponse.text();
    console.error(`[/chat] Ollama error ${ollamaResponse.status}: ${errorBody}`);
    return new Response(JSON.stringify({ error: errorBody }), {
      status: ollamaResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (!isStreaming) {
    const ollamaJSON = (await ollamaResponse.json()) as { message?: { content?: string } };
    const text = ollamaJSON.message?.content ?? "";
    // Anthropic's non-streaming shape: { content: [{ type: "text", text }] }
    return new Response(
      JSON.stringify({ content: [{ type: "text", text }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(translateOllamaStreamToAnthropicSSE(ollamaResponse.body!), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/**
 * Ollama's streaming body is newline-delimited JSON, one object per line:
 *   {"message":{"role":"assistant","content":"chunk"},"done":false}
 *   ...
 *   {"done":true, ...}
 * ClaudeAPI.swift instead expects Server-Sent Events shaped like:
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk"}}
 * This transform stream reads Ollama's stream line-by-line and re-emits
 * each text chunk as one Anthropic-style SSE event.
 */
function translateOllamaStreamToAnthropicSSE(ollamaBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";

  return ollamaBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        lineBuffer += decoder.decode(chunk, { stream: true });
        const lines = lineBuffer.split("\n");
        // The last element may be an incomplete line — keep it for next time.
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const ollamaEvent = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          const textChunk = ollamaEvent.message?.content;
          if (textChunk) {
            const anthropicEvent = {
              type: "content_block_delta",
              delta: { type: "text_delta", text: textChunk },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(anthropicEvent)}\n\n`));
          }
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    })
  );
}

async function handleTranscribeToken(env: Env): Promise<Response> {
  const response = await fetch(
    "https://streaming.assemblyai.com/v3/token?expires_in_seconds=480",
    {
      method: "GET",
      headers: {
        authorization: env.ASSEMBLYAI_API_KEY,
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/transcribe-token] AssemblyAI token error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  const data = await response.text();
  return new Response(data, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleTTS(request: Request, env: Env): Promise<Response> {
  if (env.LOCAL_TTS === "true") {
    return handleKokoroTTS(request, env);
  }

  const body = await request.text();
  const voiceId = env.ELEVENLABS_VOICE_ID;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/tts] ElevenLabs API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    },
  });
}

/**
 * Handles /tts requests when LOCAL_TTS is enabled. ElevenLabsTTSClient.swift
 * sends `{ text, model_id, voice_settings }` and expects raw `audio/mpeg`
 * bytes back. Kokoro's OpenAI-compatible endpoint wants `{ model, input,
 * voice }` and — conveniently — also returns MP3, so this is a pure field
 * rename with no audio re-encoding needed.
 */
async function handleKokoroTTS(request: Request, env: Env): Promise<Response> {
  const kokoroBaseURL = env.KOKORO_BASE_URL || "http://localhost:8000";
  const kokoroVoice = env.KOKORO_VOICE || "af_heart";

  const elevenLabsRequest = (await request.json()) as { text: string };

  const kokoroResponse = await fetch(`${kokoroBaseURL}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mlx-community/Kokoro-82M-4bit",
      input: elevenLabsRequest.text,
      voice: kokoroVoice,
    }),
  });

  if (!kokoroResponse.ok) {
    const errorBody = await kokoroResponse.text();
    console.error(`[/tts] Kokoro error ${kokoroResponse.status}: ${errorBody}`);
    return new Response(JSON.stringify({ error: errorBody }), {
      status: kokoroResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(kokoroResponse.body, {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}
