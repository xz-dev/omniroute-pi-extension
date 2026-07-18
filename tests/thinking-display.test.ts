import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ThinkingContent,
} from "@earendil-works/pi-ai";

import { wrapOmnirouteThinkingStream } from "../index.ts";

function assistant(content: ThinkingContent[]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "omniroute",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

test("preserves readable OmniRoute thinking", async () => {
  const message = assistant([{ type: "thinking", thinking: "Readable reasoning" }]);
  const source = createAssistantMessageEventStream();
  const output = wrapOmnirouteThinkingStream(source);

  source.push({ type: "start", partial: message });
  source.push({ type: "thinking_start", contentIndex: 0, partial: message });
  source.push({ type: "thinking_delta", contentIndex: 0, delta: "Readable reasoning", partial: message });
  source.push({ type: "thinking_end", contentIndex: 0, content: "Readable reasoning", partial: message });
  source.push({ type: "done", reason: "stop", message });

  assert.equal((await output.result()).content[0].thinking, "Readable reasoning");
});

test("labels encrypted or otherwise unreadable OmniRoute thinking", async () => {
  const message = assistant([
    {
      type: "thinking",
      thinking: "",
      thinkingSignature: "opaque-encrypted-reasoning",
    },
  ]);
  const source = createAssistantMessageEventStream();
  const output = wrapOmnirouteThinkingStream(source);

  source.push({ type: "start", partial: message });
  source.push({ type: "thinking_start", contentIndex: 0, partial: message });
  source.push({ type: "thinking_end", contentIndex: 0, content: "", partial: message });
  source.push({ type: "done", reason: "stop", message });

  assert.equal((await output.result()).content[0].thinking, "[Encrypted thinking...]");
});

test("labels redacted reasoning even when its provider supplied placeholder text", async () => {
  const message = assistant([
    {
      type: "thinking",
      thinking: "[Reasoning redacted]",
      thinkingSignature: "opaque-redacted-reasoning",
      redacted: true,
    },
  ]);
  const source = createAssistantMessageEventStream();
  const output = wrapOmnirouteThinkingStream(source);

  source.push({ type: "start", partial: message });
  source.push({ type: "thinking_start", contentIndex: 0, partial: message });
  source.push({ type: "thinking_end", contentIndex: 0, content: "[Reasoning redacted]", partial: message });
  source.push({ type: "done", reason: "stop", message });

  assert.equal((await output.result()).content[0].thinking, "[Encrypted thinking...]");
});
