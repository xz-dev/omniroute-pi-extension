import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const piAgentPackagePath = join(
  projectRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const piAgentPackageJson = JSON.parse(
  await readFile(join(piAgentPackagePath, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
const upstreamPiAiPackageJson = JSON.parse(
  await readFile(
    join(
      piAgentPackagePath,
      "node_modules",
      "@earendil-works",
      "pi-ai",
      "package.json",
    ),
    "utf8",
  ),
) as { name?: string; version?: string };
const { openAIResponsesApi } = await import(
  pathToFileURL(
    join(
      piAgentPackagePath,
      "node_modules",
      "@earendil-works",
      "pi-ai",
      "dist",
      "api",
      "openai-responses.lazy.js",
    ),
  ).href
);

// Consumer compatibility coverage for the upstream Responses stream bundled with Pi.

const reasoningItem = {
  id: "rs_reasoning_1",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "I should look this up." }],
  encrypted_content: "opaque-encrypted-reasoning",
};
const functionCallItem = {
  id: "fc_item_1",
  type: "function_call",
  call_id: "call_lookup_1",
  name: "lookup",
  arguments: '{"query":"Pi Responses"}',
};

let server: http.Server;
let baseUrl: string;
const requests: Array<Record<string, unknown>> = [];

function sendEvents(response: http.ServerResponse, events: Array<Record<string, unknown>>): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "close",
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}

before(async () => {
  server = http.createServer(async (request, response) => {
    assert.equal(request.url, "/v1/responses");
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    requests.push(JSON.parse(rawBody) as Record<string, unknown>);

    if (requests.length === 1) {
      const messageItem = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I'll use lookup.", annotations: [] }],
      };
      sendEvents(response, [
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_item.added", output_index: 0, item: reasoningItem },
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          summary_index: 0,
          delta: "I should look this up.",
        },
        { type: "response.output_item.done", output_index: 0, item: reasoningItem },
        { type: "response.output_item.added", output_index: 1, item: messageItem },
        {
          type: "response.output_text.delta",
          output_index: 1,
          content_index: 0,
          delta: "I'll use lookup.",
        },
        { type: "response.output_item.done", output_index: 1, item: messageItem },
        { type: "response.output_item.added", output_index: 2, item: functionCallItem },
        {
          type: "response.function_call_arguments.delta",
          output_index: 2,
          delta: functionCallItem.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 2,
          arguments: functionCallItem.arguments,
        },
        { type: "response.output_item.done", output_index: 2, item: functionCallItem },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            output: [reasoningItem, messageItem, functionCallItem],
            usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
          },
        },
      ]);
      return;
    }

    const finalMessageItem = {
      id: "msg_2",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "The result is 42.", annotations: [] }],
    };
    sendEvents(response, [
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_item.added", output_index: 0, item: finalMessageItem },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "The result is 42.",
      },
      { type: "response.output_item.done", output_index: 0, item: finalMessageItem },
      {
        type: "response.completed",
        response: {
          id: "resp_2",
          status: "completed",
          output: [finalMessageItem],
          usage: { input_tokens: 24, output_tokens: 5, total_tokens: 29 },
        },
      },
    ]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("uses the upstream Pi-AI dependency bundled with pi-coding-agent", () => {
  assert.equal(upstreamPiAiPackageJson.name, "@earendil-works/pi-ai");
  assert.match(upstreamPiAiPackageJson.version ?? "", /^0\.80\./);
  assert.match(
    piAgentPackageJson.dependencies?.["@earendil-works/pi-ai"] ?? "",
    /^\^0\.80\./,
  );
});

test("Pi's bundled Responses consumer preserves reasoning and tool-call state across turns", async () => {
  const api = openAIResponsesApi();
  const model = {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "omniroute",
    api: "openai-responses" as const,
    baseUrl,
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 372_000,
    maxTokens: 128_000,
  };
  const streamOptions = { apiKey: "test-key", maxRetries: 0 };
  const userMessage = { role: "user" as const, content: "Use the lookup tool", timestamp: 1 };

  const assistant = await api.stream(model, { messages: [userMessage] }, streamOptions).result();

  assert.equal(assistant.stopReason, "toolUse");
  assert.deepEqual(assistant.content, [
    {
      type: "thinking",
      thinking: "I should look this up.",
      thinkingSignature: JSON.stringify(reasoningItem),
    },
    { type: "text", text: "I'll use lookup.", textSignature: '{"v":1,"id":"msg_1"}' },
    {
      type: "toolCall",
      id: "call_lookup_1|fc_item_1",
      name: "lookup",
      arguments: { query: "Pi Responses" },
    },
  ]);

  const toolResult = {
    role: "toolResult" as const,
    toolCallId: "call_lookup_1|fc_item_1",
    toolName: "lookup",
    content: [{ type: "text" as const, text: "42" }],
    details: {},
    isError: false,
    timestamp: 2,
  };
  const finalAssistant = await api
    .stream(model, { messages: [userMessage, assistant, toolResult] }, streamOptions)
    .result();

  assert.deepEqual(requests[1]?.input, [
    { role: "user", content: [{ type: "input_text", text: "Use the lookup tool" }] },
    reasoningItem,
    {
      type: "message",
      role: "assistant",
      id: "msg_1",
      status: "completed",
      content: [{ type: "output_text", text: "I'll use lookup.", annotations: [] }],
    },
    functionCallItem,
    {
      type: "function_call_output",
      call_id: "call_lookup_1",
      output: "42",
    },
  ]);
  assert.deepEqual(finalAssistant.content, [
    { type: "text", text: "The result is 42.", textSignature: '{"v":1,"id":"msg_2"}' },
  ]);
  assert.equal(finalAssistant.stopReason, "stop");
});
