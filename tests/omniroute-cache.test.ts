import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import extension from "../index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "omniroute-models.json");
const projectRoot = resolve(__dirname, "..");

interface RegisteredProvider {
  name: string;
  config: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    api?: string;
    models?: Array<Record<string, unknown>>;
  };
}

interface SessionStartHandler {
  (event: { type: "session_start"; reason: "startup" }, ctx: { mode: string }): void;
}

interface SessionShutdownHandler {
  (event: { type: "session_shutdown"; reason: "quit" }, ctx: { mode: string }): void;
}

interface ExtensionHarness {
  api: ExtensionAPI;
  registeredProviders: RegisteredProvider[];
  readonly registerProviderCalls: number;
  sessionStartHandlers: SessionStartHandler[];
  sessionShutdownHandlers: SessionShutdownHandler[];
  invalidateRuntime(): void;
}

interface FixtureServer {
  baseUrl: string;
  readonly requests: number;
  readonly responses: number;
  readonly supplementalRequests: number;
  readonly supplementalResponses: number;
  readonly lastModelRequestUrl: string | undefined;
  waitForRequests(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForResponses(target: number, message: string, timeoutMs?: number): Promise<void>;
  releaseModelResponses(): void;
  close(): Promise<void>;
}

function createHarness(options: { throwOnRegisterAt?: number; invalidateOnShutdown?: boolean } = {}): ExtensionHarness {
  const registeredProviders: RegisteredProvider[] = [];
  let registerProviderCalls = 0;
  let runtimeInvalidated = false;
  const sessionStartHandlers: SessionStartHandler[] = [];
  const sessionShutdownHandlers: SessionShutdownHandler[] = [];

  const api = {
    on(event: string, handler: SessionStartHandler | SessionShutdownHandler) {
      if (event === "session_start") sessionStartHandlers.push(handler as SessionStartHandler);
      if (event === "session_shutdown") sessionShutdownHandlers.push(handler as SessionShutdownHandler);
    },
    registerProvider(name: string, config: RegisteredProvider["config"]) {
      registerProviderCalls += 1;
      if (options.throwOnRegisterAt === registerProviderCalls) {
        throw new Error(`registerProvider failed for ${name}`);
      }
      if (options.invalidateOnShutdown && runtimeInvalidated) {
        throw new Error("This extension ctx is stale after session shutdown");
      }
      registeredProviders.push({ name, config });
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    registeredProviders,
    get registerProviderCalls() {
      return registerProviderCalls;
    },
    sessionStartHandlers,
    sessionShutdownHandlers,
    invalidateRuntime() {
      runtimeInvalidated = true;
    },
  };
}

function setTTY(stdinTTY: boolean, stdoutTTY: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinTTY });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutTTY });
}

function setProcessArgs(args: string[]) {
  process.argv = [process.argv[0]!, join(projectRoot, "index.ts"), ...args];
}

function startSession(harness: ExtensionHarness, mode: "tui" | "rpc" | "json") {
  assert.equal(harness.sessionStartHandlers.length, 1, "extension should register exactly one session_start handler");
  harness.sessionStartHandlers[0]!({ type: "session_start", reason: "startup" }, { mode });
}

function shutdownSession(harness: ExtensionHarness) {
  for (const handler of harness.sessionShutdownHandlers) {
    handler({ type: "session_shutdown", reason: "quit" }, { mode: "tui" });
  }
  harness.invalidateRuntime();
}

function latestProvider(harness: ExtensionHarness) {
  return harness.registeredProviders.at(-1);
}

function modelIds(registration: RegisteredProvider | undefined) {
  return registration?.config.models?.map((model) => model.id) ?? [];
}

function createWaiterQueue() {
  let value = 0;
  const waiters: Array<{ target: number; resolve: () => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = [];

  return {
    get value() {
      return value;
    },
    increment() {
      value += 1;
      while (waiters.length > 0 && value >= waiters[0]!.target) {
        const waiter = waiters.shift()!;
        clearTimeout(waiter.timeout);
        waiter.resolve();
      }
    },
    waitFor(target: number, message: string, timeoutMs = 1000) {
      if (value >= target) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          target,
          timeout: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new assert.AssertionError({ message: `${message} (timed out after ${timeoutMs}ms; current=${value}, target=${target})` }));
          }, timeoutMs),
          resolve,
          reject,
        };
        waiters.push(waiter);
      });
    },
  };
}

interface FixtureModel {
  id?: string;
  parent?: string | null;
  root?: string | null;
  owned_by?: string;
  [key: string]: unknown;
}

function buildAliasOnlyFixture(fixture: string) {
  const payload = JSON.parse(fixture) as { data?: FixtureModel[] };
  if (!Array.isArray(payload.data)) return fixture;

  const aliasRoots = new Map<string, FixtureModel>();
  for (const model of payload.data) {
    if (typeof model.id === "string" && model.parent == null && typeof model.root === "string" && typeof model.owned_by === "string") {
      aliasRoots.set(model.id, model);
    }
  }

  const bareModelParents = new Set<string>();
  for (const model of payload.data) {
    if (typeof model.id !== "string" || model.id.includes("/")) continue;
    if (typeof model.parent === "string") bareModelParents.add(model.parent);
  }

  const aliasOnlyData = payload.data.filter((model) => {
    if (typeof model.id !== "string" || typeof model.parent !== "string" || !model.id.includes("/")) return true;
    const aliasRoot = aliasRoots.get(model.parent);
    if (!aliasRoot) return true;
    if (aliasRoot.root !== model.root || aliasRoot.owned_by !== model.owned_by) return true;
    return bareModelParents.has(model.id);
  });

  return `${JSON.stringify({ ...payload, data: aliasOnlyData })}\n`;
}

async function createFixtureServer(
  options: { delayMs?: number; holdModelResponses?: boolean; status?: number; body?: string; supplementalBody?: string; supplementalStatus?: number } = {},
): Promise<FixtureServer> {
  const fixture = await readFile(fixturePath, "utf8");
  const aliasFixture = buildAliasOnlyFixture(fixture);
  let requests = 0;
  const requestCounter = createWaiterQueue();
  const responseCounter = createWaiterQueue();
  let releaseModelResponses: (() => void) | undefined;
  const modelResponsesReleased = options.holdModelResponses
    ? new Promise<void>((resolve) => {
        releaseModelResponses = resolve;
      })
    : Promise.resolve();
  let supplementalRequests = 0;
  let supplementalResponses = 0;
  let lastModelRequestUrl: string | undefined;

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (requestUrl.pathname === "/api/v1/vscode/_/models") {
      supplementalRequests += 1;
      res.on("finish", () => {
        supplementalResponses += 1;
      });

      res.writeHead(options.supplementalStatus ?? (options.supplementalBody === undefined ? 404 : 200), { "content-type": "application/json" });
      res.end(options.supplementalBody ?? "");
      return;
    }

    if (requestUrl.pathname !== "/v1/models") {
      res.writeHead(404).end();
      return;
    }

    lastModelRequestUrl = req.url;
    requests += 1;
    requestCounter.increment();
    res.on("finish", () => {
      responseCounter.increment();
    });

    await modelResponsesReleased;
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    const responseBody =
      options.body ?? (requestUrl.searchParams.get("prefix") === "alias" ? aliasFixture : fixture);
    res.writeHead(options.status ?? 200, { "content-type": "application/json" });
    res.end(responseBody);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address === "object", "fixture server should bind to an address");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return requests;
    },
    get responses() {
      return responseCounter.value;
    },
    get supplementalRequests() {
      return supplementalRequests;
    },
    get supplementalResponses() {
      return supplementalResponses;
    },
    get lastModelRequestUrl() {
      return lastModelRequestUrl;
    },
    waitForRequests: (target: number, message: string, timeoutMs?: number) => requestCounter.waitFor(target, message, timeoutMs),
    waitForResponses: (target: number, message: string, timeoutMs?: number) => responseCounter.waitFor(target, message, timeoutMs),
    releaseModelResponses() {
      releaseModelResponses?.();
      releaseModelResponses = undefined;
    },
    close: () => {
      releaseModelResponses?.();
      releaseModelResponses = undefined;
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function readFixtureModels() {
  const payload = JSON.parse(await readFile(fixturePath, "utf8")) as { data?: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(payload.data), "fixture should expose a data array");
  return payload.data;
}

function createValidCacheJson(baseUrl: string, modelId = "cached-test-model") {
  return `${JSON.stringify(
    {
      schemaVersion: 2,
      provider: "omniroute",
      baseUrl,
      fetchedAt: "2026-06-20T00:00:00.000Z",
      models: [
        {
          id: modelId,
          name: "Cached Test Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

async function writeValidCache(cachePath: string, baseUrl: string, modelId = "cached-test-model") {
  await writeFile(cachePath, createValidCacheJson(baseUrl, modelId));
}

async function settleAsyncWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForCount(
  readCount: () => number,
  expected: number,
  message: string,
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readCount() === expected) return;
    await settleAsyncWork();
  }

  assert.fail(`${message} (timed out after ${timeoutMs}ms; current=${readCount()}, target=${expected})`);
}

async function expectCountToStayStable(
  readCount: () => number,
  expected: number,
  durationMs: number,
  message: string,
) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    assert.equal(readCount(), expected, message);
    await settleAsyncWork();
  }
}

async function captureConsoleWarns<T>(fn: () => Promise<T>) {
  const originalWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const value = await fn();
    return { value, warns };
  } finally {
    console.warn = originalWarn;
  }
}

function defaultCachePath(baseUrl: string, agentDir: string) {
  const hash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
  return join(agentDir, "omniroute", `models-${hash}.json`);
}

let oldArgv: string[];
let oldEnv: NodeJS.ProcessEnv;
let oldStdinIsTTY: PropertyDescriptor | undefined;
let oldStdoutIsTTY: PropertyDescriptor | undefined;
let tempDir: string;

beforeEach(async () => {
  oldArgv = [...process.argv];
  oldEnv = { ...process.env };
  oldStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  oldStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  tempDir = await mkdtemp(join(tmpdir(), "omniroute-cache-test-"));

  setProcessArgs([]);
  setTTY(true, true);
  process.env.OMNIROUTE_API_KEY = "test-key";
  process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "100";
});

afterEach(async () => {
  process.argv = oldArgv;
  process.env = oldEnv;

  if (oldStdinIsTTY) Object.defineProperty(process.stdin, "isTTY", oldStdinIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;

  if (oldStdoutIsTTY) Object.defineProperty(process.stdout, "isTTY", oldStdoutIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;

  await rm(tempDir, { recursive: true, force: true });
});

function configureCacheStartup(baseUrl: string, cachePath: string | undefined, argv: string[] = []) {
  process.env.OMNIROUTE_BASE_URL = baseUrl;
  if (cachePath === undefined) delete process.env.OMNIROUTE_MODEL_CACHE_PATH;
  else process.env.OMNIROUTE_MODEL_CACHE_PATH = cachePath;
  setProcessArgs(argv);
}

describe("OmniRoute model catalog cache", () => {
  it("uses the cache-first flow for interactive startup and --list-models", async () => {
    const oldDiscoveryTimeout = process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS;
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "1000";

    const interactiveServer = await createFixtureServer({ delayMs: 200 });
    try {
      const cachePath = join(tempDir, "interactive-cache.json");
      await writeValidCache(cachePath, interactiveServer.baseUrl);
      configureCacheStartup(interactiveServer.baseUrl, cachePath);

      const interactive = createHarness();
      await extension(interactive.api);
      assert.deepEqual(modelIds(latestProvider(interactive)), ["cached-test-model"], "interactive TUI startup should register the cached provider immediately");
      assert.equal(latestProvider(interactive)!.config.api, "openai-responses", "cached startup should use Pi's Responses provider API");
      assert.equal(latestProvider(interactive)!.config.apiKey, "$OMNIROUTE_API_KEY", "cached startup should keep the literal discovery key reference");
      assert.equal(interactiveServer.responses, 0, "interactive startup should not wait for background refresh before returning");

      await interactiveServer.waitForResponses(1, "interactive cache-hit startup should refresh models in the background");
      await waitForProviderCount(interactive, 2, "interactive cache-hit startup should replace the cached provider after background refresh");
      assert.equal(interactiveServer.requests, 1, "interactive cache-hit startup should issue one background discovery request");
      assert.ok(latestProvider(interactive)!.config.models!.length > 100, "interactive cache-hit startup should eventually replace the cached placeholder catalog");
    } finally {
      await interactiveServer.close();
    }

    const listModelsServer = await createFixtureServer({ delayMs: 200 });
    try {
      const cachePath = join(tempDir, "list-models-cache.json");
      await writeValidCache(cachePath, listModelsServer.baseUrl);
      configureCacheStartup(listModelsServer.baseUrl, cachePath, ["--list-models"]);

      const listModels = createHarness();
      await extension(listModels.api);
      assert.deepEqual(modelIds(latestProvider(listModels)), ["cached-test-model"], "--list-models should register the cached provider immediately");
      assert.equal(latestProvider(listModels)!.config.apiKey, "$OMNIROUTE_API_KEY", "--list-models should keep the literal discovery key reference");
      assert.equal(listModelsServer.responses, 0, "--list-models should not wait for background refresh before returning");

      await listModelsServer.waitForResponses(1, "--list-models cache-hit startup should refresh models in the background");
      await waitForProviderCount(listModels, 2, "--list-models cache-hit startup should replace the cached provider after background refresh");
      assert.equal(listModelsServer.requests, 1, "--list-models cache-hit startup should issue one background discovery request");
      assert.ok(latestProvider(listModels)!.config.models!.length > 100, "--list-models cache-hit startup should eventually replace the cached placeholder catalog");
    } finally {
      await listModelsServer.close();
      if (oldDiscoveryTimeout === undefined) delete process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS;
      else process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = oldDiscoveryTimeout;
    }
  });

  it("does not register cached models for metadata-only startup modes", async () => {
    const server = await createFixtureServer();
    try {
      const cases = [
        { name: "--help", argv: ["--help"] },
        { name: "-h", argv: ["-h"] },
        { name: "--version", argv: ["--version"] },
        { name: "-v", argv: ["-v"] },
      ] as const;

      for (const testCase of cases) {
        const cachePath = join(tempDir, `${testCase.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
        await writeValidCache(cachePath, server.baseUrl);
        configureCacheStartup(server.baseUrl, cachePath, [...testCase.argv]);

        const harness = createHarness();
        await assert.doesNotReject(() => extension(harness.api), `${testCase.name} startup should not throw`);
        assert.equal(server.requests, 0, `${testCase.name} should not hit live discovery`);
        assert.equal(harness.registeredProviders.length, 0, `${testCase.name} should skip model registration`);
      }
    } finally {
      await server.close();
    }
  });

  it("does not register an old completions cache without an API key", async () => {
    const cachePath = join(tempDir, "models-v1.json");
    const baseUrl = "https://offline.invalid";
    await writeFile(cachePath, createValidCacheJson(baseUrl).replace('"schemaVersion": 2', '"schemaVersion": 1'));
    configureCacheStartup(baseUrl, cachePath, ["--print"]);
    delete process.env.OMNIROUTE_API_KEY;

    const harness = createHarness();
    await assert.doesNotReject(() => extension(harness.api));

    assert.equal(harness.registeredProviders.length, 0, "v1 completions caches must not register Responses models");
  });

  it("registers cached models for headless startup modes without refreshing", async () => {
    const server = await createFixtureServer();
    try {
      const cases = [
        { name: "--print", argv: ["--print"], stdinTTY: true, stdoutTTY: true },
        { name: "-p", argv: ["-p"], stdinTTY: true, stdoutTTY: true },
        { name: "--mode rpc", argv: ["--mode", "rpc"], stdinTTY: true, stdoutTTY: true },
        { name: "--mode=json", argv: ["--mode=json"], stdinTTY: true, stdoutTTY: true },
        { name: "stdin non-TTY", argv: [], stdinTTY: false, stdoutTTY: true },
        { name: "stdout non-TTY", argv: [], stdinTTY: true, stdoutTTY: false },
        { name: "SDK/subagent worker stdio", argv: [], stdinTTY: false, stdoutTTY: false },
      ] as const;

      for (const testCase of cases) {
        const cachePath = join(tempDir, `${testCase.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
        await writeValidCache(cachePath, server.baseUrl);
        configureCacheStartup(server.baseUrl, cachePath, [...testCase.argv]);
        setTTY(testCase.stdinTTY, testCase.stdoutTTY);

        const harness = createHarness();
        await extension(harness.api);
        assert.deepEqual(modelIds(latestProvider(harness)), ["cached-test-model"], `${testCase.name} should register cached models during startup`);
        assert.equal(latestProvider(harness)!.config.apiKey, "$OMNIROUTE_API_KEY", `${testCase.name} should keep the literal discovery key reference`);
        await expectCountToStayStable(() => server.requests, 0, 100, `${testCase.name} should not refresh cached models in the background`);
      }
    } finally {
      await server.close();
    }
  });

  it("rejects invalid or mismatched cache files without throwing", async () => {
    const server = await createFixtureServer();
    try {
      const validBaseUrl = server.baseUrl;
      const mismatchedBaseUrl = `${server.baseUrl}-other`;
      const cases = [
        {
          name: "old completions cache schema",
          content: createValidCacheJson(validBaseUrl).replace('"schemaVersion": 2', '"schemaVersion": 1'),
          argv: [] as const,
        },
        {
          name: "wrong provider",
          content: createValidCacheJson(validBaseUrl).replace('"provider": "omniroute"', '"provider": "other"'),
          argv: [] as const,
        },
        {
          name: "wrong baseUrl",
          content: createValidCacheJson(mismatchedBaseUrl),
          argv: ["--list-models"] as const,
        },
        {
          name: "empty models array",
          content: `${JSON.stringify({ schemaVersion: 2, provider: "omniroute", baseUrl: validBaseUrl, fetchedAt: "2026-06-20T00:00:00.000Z", models: [] }, null, 2)}\n`,
          argv: [] as const,
        },
        {
          name: "malformed JSON",
          content: "{\n  \"schemaVersion\": 1,\n  \"provider\": \"omniroute\"\n",
          argv: [] as const,
        },
        {
          name: "invalid model shape",
          content: `${JSON.stringify(
            {
              schemaVersion: 2,
              provider: "omniroute",
              baseUrl: validBaseUrl,
              fetchedAt: "2026-06-20T00:00:00.000Z",
              models: [{ id: "broken-model" }],
            },
            null,
            2,
          )}\n`,
          argv: [] as const,
        },
      ] as const;

      const { warns } = await captureConsoleWarns(async () => {
        for (const testCase of cases) {
          const cachePath = join(tempDir, `${testCase.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
          await writeFile(cachePath, testCase.content);
          configureCacheStartup(validBaseUrl, cachePath, [...testCase.argv]);

          const beforeRequests = server.requests;
          const harness = createHarness();
          await extension(harness.api);

          assert.equal(server.requests, beforeRequests + 1, `${testCase.name} should perform one live discovery request when cache validation fails`);
          assert.ok(latestProvider(harness)!.config.models!.length > 100, `${testCase.name} should register the live discovered model catalog`);
          assert.equal(modelIds(latestProvider(harness)).includes("cached-test-model"), false, `${testCase.name} should not leave the placeholder model in place`);

          const normalizedCache = JSON.parse(await readFile(cachePath, "utf8"));
          assert.equal(normalizedCache.schemaVersion, 2, `${testCase.name} should write the Responses cache schema`);
          assert.equal(normalizedCache.baseUrl, validBaseUrl, `${testCase.name} should write a normalized cache after successful discovery`);
          assert.ok(Array.isArray(normalizedCache.models) && normalizedCache.models.length > 100, `${testCase.name} should persist the normalized live model catalog`);
        }
      });

      assert.ok(warns.some((line) => line.includes("Ignoring invalid model cache") || line.includes("Could not read model cache") || line.includes("Supplemental reasoning-effort discovery failed")), "invalid cache cases should emit expected warnings");
    } finally {
      await server.close();
    }
  });

  it("registers cached models on startup even when OMNIROUTE_API_KEY is missing, and skips refresh until credentials exist", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "missing-api-key.json");
      await writeValidCache(cachePath, server.baseUrl);
      delete process.env.OMNIROUTE_API_KEY;
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      extension(harness.api);
      assert.equal(server.requests, 0, "cached startup without credentials should not hit live discovery before session_start");
      assert.deepEqual(modelIds(latestProvider(harness)), ["cached-test-model"], "cached startup without credentials should still register the cached provider immediately");
      assert.equal(latestProvider(harness)!.config.apiKey, "$OMNIROUTE_API_KEY", "cached startup should keep the literal discovery key reference");

      const cacheBeforeSessionStart = await readFile(cachePath, "utf8");
      startSession(harness, "tui");
      await expectCountToStayStable(() => server.requests, 0, 100, "missing API key should prevent TUI refresh from hitting live discovery");
      assert.equal(await readFile(cachePath, "utf8"), cacheBeforeSessionStart, "missing API key should not rewrite the cache");
    } finally {
      await server.close();
    }
  });

  it("falls back to blocking discovery when no valid cache exists for interactive startup and --list-models", async () => {
    const server = await createFixtureServer();
    try {
      const cases = [
        { name: "interactive startup", argv: [] },
        { name: "--list-models", argv: ["--list-models"] },
      ] as const;

      for (const testCase of cases) {
        const cachePath = join(tempDir, `${testCase.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
        configureCacheStartup(server.baseUrl, cachePath, [...testCase.argv]);

        const beforeRequests = server.requests;
        const harness = createHarness();
        await extension(harness.api);

        assert.equal(server.requests, beforeRequests + 1, `${testCase.name} should perform one live discovery request when no cache exists`);
        assert.ok(latestProvider(harness)!.config.models!.length > 100, `${testCase.name} should register the live discovered model catalog`);
        assert.equal(modelIds(latestProvider(harness)).includes("cached-test-model"), false, `${testCase.name} should not invent cached placeholder models`);

        const cache = JSON.parse(await readFile(cachePath, "utf8"));
        assert.equal(cache.baseUrl, server.baseUrl, `${testCase.name} should write a normalized cache for future cache-first starts`);
        assert.ok(cache.models.length > 100, `${testCase.name} should persist the live model catalog`);
      }
    } finally {
      await server.close();
    }
  });

  it("registers live discovered models when cache persistence fails", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "unwritable-cache-path");
      await mkdir(cachePath, { recursive: true });
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      const { warns } = await captureConsoleWarns(async () => {
        await extension(harness.api);
      });

      assert.equal(server.requests, 1, "cache write failure fallback should still perform one live discovery request");
      assert.ok(latestProvider(harness)!.config.models!.length > 100, "successful live discovery should still register a provider when cache write fails");
      assert.equal(modelIds(latestProvider(harness)).includes("cached-test-model"), false, "cache write failure fallback should register live models, not placeholder cache data");
      assert.ok(warns.some((line) => line.includes("Model discovery succeeded but cache write failed")), "cache write failure should be logged");
    } finally {
      await server.close();
    }
  });

  it("falls back to blocking discovery for headless startup when no valid cache exists", async () => {
    const server = await createFixtureServer();
    try {
      const cases = [
        { name: "--print", argv: ["--print"], stdinTTY: true, stdoutTTY: true },
        { name: "-p", argv: ["-p"], stdinTTY: true, stdoutTTY: true },
        { name: "--mode rpc", argv: ["--mode", "rpc"], stdinTTY: true, stdoutTTY: true },
        { name: "--mode=json", argv: ["--mode=json"], stdinTTY: true, stdoutTTY: true },
        { name: "stdin non-TTY", argv: [], stdinTTY: false, stdoutTTY: true },
        { name: "stdout non-TTY", argv: [], stdinTTY: true, stdoutTTY: false },
        { name: "SDK/subagent worker stdio", argv: [], stdinTTY: false, stdoutTTY: false },
      ] as const;

      for (const testCase of cases) {
        const cachePath = join(tempDir, `${testCase.name.replace(/[^a-z0-9]+/gi, "-")}-missing-cache.json`);
        configureCacheStartup(server.baseUrl, cachePath, [...testCase.argv]);
        setTTY(testCase.stdinTTY, testCase.stdoutTTY);

        const beforeRequests = server.requests;
        const harness = createHarness();
        await extension(harness.api);

        assert.equal(server.requests, beforeRequests + 1, `${testCase.name} should perform one live discovery request when no cache exists`);
        assert.ok(latestProvider(harness)!.config.models!.length > 100, `${testCase.name} should register the live discovered model catalog`);
        assert.equal(modelIds(latestProvider(harness)).includes("cached-test-model"), false, `${testCase.name} should not invent cached placeholder models`);

        const cache = JSON.parse(await readFile(cachePath, "utf8"));
        assert.equal(cache.baseUrl, server.baseUrl, `${testCase.name} should write a normalized cache for future cache-first starts`);
        assert.ok(cache.models.length > 100, `${testCase.name} should persist the live model catalog`);
      }
    } finally {
      await server.close();
    }
  });

  it("honors offline mode by using cached models without refreshing or discovering", async () => {
    const server = await createFixtureServer();
    try {
      process.env.PI_OFFLINE = "1";
      const cachePath = join(tempDir, "offline-cache.json");
      await writeValidCache(cachePath, server.baseUrl);
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      await extension(harness.api);
      assert.deepEqual(modelIds(latestProvider(harness)), ["cached-test-model"], "offline startup should still register cached models");
      assert.equal(latestProvider(harness)!.config.api, "openai-responses", "offline cached startup should preserve the provider-wide Responses API");
      startSession(harness, "tui");
      await expectCountToStayStable(() => server.requests, 0, 100, "offline startup/session_start should not hit live discovery");

      const noCachePath = join(tempDir, "offline-missing-cache.json");
      configureCacheStartup(server.baseUrl, noCachePath, []);
      const noCacheHarness = createHarness();
      await extension(noCacheHarness.api);
      assert.equal(noCacheHarness.registeredProviders.length, 0, "offline no-cache startup should not register a provider");
      await expectCountToStayStable(() => server.requests, 0, 100, "offline no-cache startup should not discover live models");
    } finally {
      await server.close();
    }
  });

  it("hides synthetic Codex ultra aliases from an existing offline cache", async () => {
    process.env.PI_OFFLINE = "1";
    const baseUrl = "https://omniroute-cache.example/api/v1";
    const cachePath = join(tempDir, "offline-ultra-cache.json");
    const cache = JSON.parse(createValidCacheJson(baseUrl));
    const template = cache.models[0];
    cache.models = [
      template,
      { ...template, id: "cx/gpt-5.6-sol-ultra", name: "gpt-5.6-sol-ultra" },
      { ...template, id: "codex/gpt-5.6-terra-ultra", name: "gpt-5.6-terra-ultra" },
      { ...template, id: "cx/gpt-5.7-ultra", name: "gpt-5.7-ultra" },
      { ...template, id: "other/gpt-5.6-sol-ultra", name: "gpt-5.6-sol-ultra" },
    ];
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    configureCacheStartup(baseUrl, cachePath, []);

    const harness = createHarness();
    await extension(harness.api);

    const ids = modelIds(latestProvider(harness));
    assert.equal(ids.includes("cx/gpt-5.6-sol-ultra"), false, "a stale alias-prefixed Sol ultra cache entry should be hidden");
    assert.equal(ids.includes("codex/gpt-5.6-terra-ultra"), false, "a stale canonical Terra ultra cache entry should be hidden");
    assert.equal(ids.includes("cx/gpt-5.7-ultra"), true, "other cached Codex ultra IDs should remain routable");
    assert.equal(ids.includes("other/gpt-5.6-sol-ultra"), true, "another provider's cached ultra model should remain routable");
  });

  it("uses cache-hit startup refresh and lets TUI session_start reuse the in-flight request", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "models.json");
      await writeValidCache(cachePath, server.baseUrl);
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      const extensionPromise = extension(harness.api);
      assert.deepEqual(modelIds(latestProvider(harness)), ["cached-test-model"], "cache-hit startup should register the cached provider immediately");
      assert.equal(latestProvider(harness)!.config.apiKey, "$OMNIROUTE_API_KEY", "cache-hit startup should keep the literal discovery key reference");

      startSession(harness, "tui");
      await extensionPromise;
      await server.waitForResponses(1, "cache-hit startup refresh should complete once");
      await waitForProviderCount(harness, 2, "cache-hit startup refresh should replace the cached provider after live discovery");

      assert.equal(server.requests, 1, "cache-hit startup should issue exactly one live /models request");
      assert.equal(latestProvider(harness)!.name, "omniroute", "live provider should be registered under the OmniRoute provider key");
      assert.ok(latestProvider(harness)!.config.models!.length > 100, "real OmniRoute fixture should normalize to a large live catalog");
      assert.ok(!modelIds(latestProvider(harness)).includes("cached-test-model"), "cached placeholder model should not survive live refresh");

      const cache = JSON.parse(await readFile(cachePath, "utf8"));
      assert.equal(cache.provider, "omniroute", "cache should store the provider name only");
      assert.equal(cache.baseUrl, server.baseUrl, "cache should normalize the baseUrl used for discovery");
      assert.ok(Array.isArray(cache.models), "cache should store model entries");
      assert.ok(cache.models.length > 100, "cache should contain the refreshed live catalog");
      assert.equal(cache.models.some((model: { id: string }) => model.id === "cached-test-model"), false, "refreshed cache should replace the placeholder model set");

      const secondStartup = createHarness();
      configureCacheStartup(server.baseUrl, cachePath, []);
      await extension(secondStartup.api);
      assert.equal(secondStartup.registeredProviders.length, 1, "normalized cache should register immediately on a subsequent cache-hit startup");
      await server.waitForResponses(2, "subsequent cache-hit startup should complete a second background refresh");
      await waitForProviderCount(secondStartup, 2, "subsequent cache-hit startup should replace the cached provider after background refresh");
      assert.equal(server.requests, 2, "subsequent cache-hit startup should issue a second live /models request");
      assert.equal(latestProvider(secondStartup)!.config.baseUrl, server.baseUrl, "subsequent startup should read the normalized baseUrl from cache");
      assert.ok(latestProvider(secondStartup)!.config.models!.length > 100, "subsequent startup should restore the refreshed live catalog from cache");
    } finally {
      await server.close();
    }
  });

  it("refreshes again when later TUI session_start events happen after the first refresh completed", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "repeat-refresh.json");
      await writeValidCache(cachePath, server.baseUrl);
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      extension(harness.api);
      startSession(harness, "tui");
      await server.waitForResponses(1, "first TUI refresh should complete before testing the next session_start");
      await waitForProviderCount(harness, 2, "first refresh should register a live provider");

      startSession(harness, "tui");
      await server.waitForResponses(2, "later TUI session_start should trigger a second live refresh after the first completed");
      await waitForProviderCount(harness, 3, "later TUI session_start should register another refreshed provider");

      assert.equal(server.requests, 2, "each completed TUI session_start should refresh the live catalog again");
    } finally {
      await server.close();
    }
  });

  it("does not update a disposed TUI extension after delayed discovery completes", async () => {
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "1000";
    const server = await createFixtureServer({ holdModelResponses: true });
    try {
      const cachePath = join(tempDir, "shutdown-during-refresh.json");
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness({ invalidateOnShutdown: true });
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        const { warns } = await captureConsoleWarns(async () => {
          const extensionPromise = extension(harness.api);
          startSession(harness, "tui");
          await server.waitForRequests(1, "TUI refresh should start before shutdown");
          shutdownSession(harness);
          server.releaseModelResponses();
          await extensionPromise;
          const cache = JSON.parse(await readFile(cachePath, "utf8")) as { models?: unknown[] };
          assert.ok(Array.isArray(cache.models) && cache.models.length > 100, "discovery should persist the normalized model cache after shutdown");
          await settleAsyncWork();
        });

        assert.equal(harness.registerProviderCalls, 0, "shutdown should prevent the post-discovery provider update");
        assert.equal(harness.registeredProviders.length, 0, "shutdown should not register a provider after discovery");
        assert.equal(
          warns.some((line) => line.includes("provider update failed")),
          false,
          "expected shutdown should not log a provider-update warning",
        );
        assert.equal(unhandledRejections.length, 0, "expected shutdown should not create an unhandled rejection");
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    } finally {
      await server.close();
    }
  });

  it("handles async provider registration failures without unhandled rejections", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "register-throws.json");
      await writeValidCache(cachePath, server.baseUrl);
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness({ throwOnRegisterAt: 2 });
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        const { warns } = await captureConsoleWarns(async () => {
          extension(harness.api);
          startSession(harness, "tui");
          await server.waitForResponses(1, "throwing registerProvider should still complete the live discovery response");
          await waitForCount(() => harness.registerProviderCalls, 2, "throwing registerProvider should still be attempted once during async refresh");
        });

        assert.equal(unhandledRejections.length, 0, "async refresh provider registration failures should not become unhandled rejections");
        assert.ok(
          warns.some((line) => line.includes("provider update failed") || line.includes("registerProvider failed")),
          "async provider registration failure should be logged",
        );
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    } finally {
      await server.close();
    }
  });

  it("coalesces no-cache bootstrap discovery with an immediate TUI session_start", async () => {
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "1000";
    const server = await createFixtureServer({ delayMs: 250 });
    try {
      const cachePath = join(tempDir, "no-cache-immediate-session-start.json");
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      const extensionPromise = extension(harness.api);
      startSession(harness, "tui");

      await extensionPromise;
      await server.waitForResponses(1, "no-cache bootstrap plus immediate session_start should still complete one live request");
      await waitForProviderCount(harness, 1, "no-cache bootstrap plus immediate session_start should register a single live provider");

      assert.equal(server.requests, 1, "no-cache bootstrap plus immediate session_start should issue only one live /models request");
      assert.ok(latestProvider(harness)!.config.models!.length > 100, "no-cache bootstrap plus immediate session_start should register the live discovered catalog");

      const cache = JSON.parse(await readFile(cachePath, "utf8"));
      assert.equal(cache.baseUrl, server.baseUrl, "no-cache bootstrap should write a normalized cache after the single live discovery");
      assert.ok(cache.models.length > 100, "no-cache bootstrap should persist the live discovered catalog");
    } finally {
      await server.close();
    }
  });

  it("does not trigger extra refresh work for non-TUI session_start after startup refresh completes", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "models.json");
      await writeValidCache(cachePath, server.baseUrl);
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      configureCacheStartup(server.baseUrl, cachePath, ["--mode", "rpc"]);
      await extension(harness.api);
      assert.deepEqual(modelIds(latestProvider(harness)), ["cached-test-model"], "RPC startup should register the cached provider immediately");

      const cacheAfterStartup = await readFile(cachePath, "utf8");
      startSession(harness, "rpc");
      startSession(harness, "json");

      await expectCountToStayStable(() => server.requests, 0, 100, "non-TUI startup/session_start should not trigger live /models discovery");
      assert.equal(await readFile(cachePath, "utf8"), cacheAfterStartup, "non-TUI session_start should not rewrite the cache");
      assert.deepEqual(modelIds(latestProvider(harness)), ["cached-test-model"], "non-TUI session_start should keep the cached provider intact");
    } finally {
      await server.close();
    }
  });

  it("keeps cached provider and cache when discovery does not return a usable live catalog", async () => {
    const fixtureModels = await readFixtureModels();
    const imageOnlyModel = fixtureModels.find((model) => model.id === "codex/gpt-5.5" && model.type === "image");
    assert.ok(imageOnlyModel, "fixture should include the unusable image-output codex/gpt-5.5 variant");
    assert.equal(
      Array.isArray(imageOnlyModel!.output_modalities) && imageOnlyModel!.output_modalities.includes("text"),
      false,
      "image-output codex/gpt-5.5 should be unusable for text discovery",
    );

    const payloadCases: Array<{ name: string; body: string; status?: number }> = [
      { name: "HTTP 503", status: 503, body: "service unavailable" },
      { name: "invalid JSON", body: "{\"data\": [" },
      { name: "empty data array", body: JSON.stringify({ data: [] }) },
      { name: "unusable non-text payload", body: JSON.stringify({ data: [imageOnlyModel] }) },
    ];

    for (const payloadCase of payloadCases) {
      const server = await createFixtureServer({ status: payloadCase.status, body: payloadCase.body });
      try {
        const cachePath = join(tempDir, `${payloadCase.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
        await writeValidCache(cachePath, server.baseUrl);
        const originalCache = await readFile(cachePath, "utf8");
        configureCacheStartup(server.baseUrl, cachePath, []);

        const harness = createHarness();
        const { warns } = await captureConsoleWarns(async () => {
          extension(harness.api);
          startSession(harness, "tui");

          await server.waitForResponses(1, `${payloadCase.name} should still complete one discovery response`);
          await expectCountToStayStable(() => harness.registeredProviders.length, 1, 100, `${payloadCase.name} should not register a fresh provider`);

          assert.equal(server.requests, 1, `${payloadCase.name} should still be attempted exactly once`);
          assert.deepEqual(modelIds(latestProvider(harness)), ["cached-test-model"], `${payloadCase.name} should leave the cached provider unchanged`);
          assert.equal(await readFile(cachePath, "utf8"), originalCache, `${payloadCase.name} should not rewrite the cache unless discovery returns a usable live catalog`);
        });

        assert.ok(warns.some((line) => line.includes("Model discovery failed")), `${payloadCase.name} should warn about live discovery failure`);
      } finally {
        await server.close();
      }
    }
  });

  it("normalizes real OmniRoute models from the fixture into semantic provider entries", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "models.json");
      await writeValidCache(cachePath, server.baseUrl);
      configureCacheStartup(server.baseUrl, cachePath, []);

      const fixtureModels = await readFixtureModels();
      const codexGpt55Variants = fixtureModels.filter((model) => model.id === "codex/gpt-5.5");
      assert.equal(codexGpt55Variants.length, 2, "fixture should include one text-capable and one image-output GPT 5.5 variant under the same ID");
      assert.ok(codexGpt55Variants.some((model) => model.type === "image"), "fixture should include the unusable image-output GPT 5.5 variant to prove filtering works");
      assert.ok(codexGpt55Variants.some((model) => Array.isArray(model.output_modalities) && model.output_modalities.includes("text")), "fixture should include the usable text-output GPT 5.5 variant");

      const harness = createHarness();
      extension(harness.api);
      startSession(harness, "tui");
      await server.waitForResponses(1, "real fixture normalization should complete once the live catalog is fetched");
      await waitForProviderCount(harness, 2, "live refresh should register a normalized provider list");

      const liveRegistration = latestProvider(harness)!;
      assert.equal(liveRegistration.name, "omniroute", "live provider should be registered under the OmniRoute provider key");
      assert.equal(liveRegistration.config.name, "OmniRoute", "live provider should expose the OmniRoute display name");
      assert.equal(liveRegistration.config.api, "openai-responses", "live provider should use Pi's OpenAI Responses API");
      assert.ok(
        server.lastModelRequestUrl?.includes("prefix=alias"),
        "live discovery should request the alias prefix mode so the catalog shows short provider aliases instead of full provider ids",
      );

      const models = liveRegistration.config.models ?? [];
      const modelById = new Map(models.map((model) => [model.id, model]));

      const textOnly = modelById.get("oc/big-pickle");
      assert.ok(textOnly, "fixture should normalize the text-only Big Pickle model");
      assert.deepEqual(textOnly!.input, ["text"], "text-only models should keep a single text input modality");

      const deepseekThinking = modelById.get("ds/deepseek-v4-pro");
      assert.ok(deepseekThinking, "fixture should normalize the DeepSeek thinking-family model");
      assert.equal(deepseekThinking!.reasoning, true, "DeepSeek thinking-family models should remain reasoning-capable");
      assert.ok(deepseekThinking!.thinkingLevelMap, "DeepSeek thinking-family models should retain their thinking-level map");
      assert.equal(
        Object.hasOwn(deepseekThinking!, "compat"),
        false,
        "Responses models must not inherit OpenAI Completions-only DeepSeek compatibility",
      );

      const imageCapable = modelById.get("cx/gpt-5.5");
      assert.ok(imageCapable, "fixture should normalize the GPT 5.5 model");
      assert.deepEqual(imageCapable!.input, ["text", "image"], "image-capable GPT 5.5 should expose both text and image input modalities");
      assert.equal(imageCapable!.reasoning, true, "GPT 5.5 should remain reasoning-capable after normalization");
      assert.deepEqual(
        imageCapable!.thinkingLevelMap,
        {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: null,
        },
        "GPT 5.5 thinking variants should merge into a single semantic provider entry",
      );
      assert.equal(modelById.has("cx/gpt-5.5-low"), false, "thinking variants should merge into the base model instead of appearing separately");
      assert.equal(modelById.has("cx/gpt-5.5-medium"), false, "thinking variants should merge into the base model instead of appearing separately");
      assert.equal(modelById.has("cx/gpt-5.5-high"), false, "thinking variants should merge into the base model instead of appearing separately");
      assert.equal(modelById.has("cx/gpt-5.5-xhigh"), false, "thinking variants should merge into the base model instead of appearing separately");
      assert.equal(modelById.has("codex/gpt-5.5"), false, "the normalized catalog should drop the canonical provider-id form when the alias root cx/gpt-5.5 is present, so the UI shows the short alias prefix only");
    } finally {
      await server.close();
    }
  });

  it("folds verified reasoning variants, preserves max, and hides synthetic Codex ultra aliases", async () => {
    const primaryBody = JSON.stringify({
      data: [
        {
          id: "ddgw/gpt-4o-mini",
          object: "model",
          root: "gpt-4o-mini",
          owned_by: "duckduckgo-web",
          output_modalities: ["text"],
          context_length: 128000,
          max_output_tokens: 4096,
        },
        {
          id: "codex/gpt-5.6-sol",
          name: "GPT 5.6 Sol",
          object: "model",
          root: "gpt-5.6-sol",
          owned_by: "codex",
          capabilities: { reasoning: true },
          output_modalities: ["text"],
          context_length: 400000,
          max_output_tokens: 128000,
        },
        ...["none", "low", "xhigh", "max"].map((effort) => ({
          id: `codex/gpt-5.6-sol-${effort}`,
          object: "model",
          root: `gpt-5.6-sol-${effort}`,
          owned_by: "codex",
          output_modalities: ["text"],
          context_length: 400000,
          max_output_tokens: 128000,
        })),
        {
          id: "aug/gpt-5.5",
          object: "model",
          owned_by: "augment-code",
          type: "image",
          output_modalities: ["image"],
        },
        {
          id: "aug/gpt-5.5-high",
          object: "model",
          root: "gpt-5.5-high",
          owned_by: "augment-code",
          capabilities: { effort_tiers: ["low", "medium", "high"] },
          output_modalities: ["text"],
        },
        {
          id: "cx/gpt-5.6-terra",
          object: "model",
          root: "gpt-5.6-terra",
          owned_by: "codex",
          capabilities: { reasoning: true },
          output_modalities: ["text"],
        },
        {
          id: "cx/gpt-5.6-terra-max",
          object: "model",
          root: "gpt-5.6-terra-max",
          owned_by: "codex",
          output_modalities: ["text"],
        },
        {
          id: "cx/gpt-5.6-sol-ultra",
          object: "model",
          root: "gpt-5.6-sol-ultra",
          owned_by: "codex",
          output_modalities: ["text"],
        },
        {
          id: "cx/gpt-5.6-terra-ultra",
          object: "model",
          root: "gpt-5.6-terra-ultra",
          owned_by: "codex",
          output_modalities: ["text"],
        },
        {
          id: "cx/gpt-5.7-ultra",
          object: "model",
          root: "gpt-5.7-ultra",
          owned_by: "codex",
          output_modalities: ["text"],
        },
        {
          id: "other/gpt-5.6-sol-ultra",
          object: "model",
          root: "gpt-5.6-sol-ultra",
          owned_by: "other-provider",
          output_modalities: ["text"],
        },
      ],
    });
    const supplementalBody = JSON.stringify({
      data: [
        {
          id: "ddgw/gpt-4o-mini",
          supportedReasoningEfforts: ["none", "low", "high", "max"],
        },
        {
          id: "vscode-family-gpt-5.6-sol",
          root: "gpt-5.6-sol",
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      ],
    });

    const server = await createFixtureServer({ body: primaryBody, supplementalBody });
    try {
      const cachePath = join(tempDir, "supplemental-efforts.json");
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      await extension(harness.api);

      assert.equal(server.requests, 1, "live discovery should fetch the primary model catalog once");
      assert.equal(server.supplementalRequests, 1, "live discovery should fetch supplemental reasoning-effort metadata once");
      assert.equal(server.supplementalResponses, 1, "supplemental reasoning-effort metadata request should complete once");

      const models = latestProvider(harness)!.config.models ?? [];
      const model = models.find((candidate) => candidate.id === "ddgw/gpt-4o-mini");
      assert.ok(model, "primary model should remain registered");
      assert.deepEqual(
        model.thinkingLevelMap,
        {
          off: null,
          minimal: "low",
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
        "supplemental efforts should omit Pi off and preserve max without conflation",
      );
      assert.deepEqual(model.input, ["text"], "primary catalog metadata should remain the source of model capabilities");
      assert.equal(model.contextWindow, 128000, "primary catalog metadata should remain the source of context limits");

      const gpt56 = models.find((candidate) => candidate.id === "codex/gpt-5.6-sol");
      assert.ok(gpt56, "the exact primary base model should remain registered");
      assert.equal(gpt56.name, "gpt-5.6-sol", "the primary base entry should remain the source of display metadata");
      assert.deepEqual(
        gpt56.thinkingLevelMap,
        {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        "verified suffix variants and supplemental metadata should merge into the exact canonical base",
      );
      assert.equal(models.some((candidate) => candidate.id === "vscode-family-gpt-5.6-sol"), false, "supplemental VS Code metadata must not create or replace registered model ids");
      for (const effort of ["none", "low", "xhigh", "max"]) {
        assert.equal(models.some((candidate) => candidate.id === `codex/gpt-5.6-sol-${effort}`), false, `verified ${effort} variants should fold into the canonical base`);
      }
      assert.equal(models.some((candidate) => candidate.id === "aug/gpt-5.5-high"), true, "a whitelisted suffix without an eligible text base must remain routable even when a same-ID base is image-only and the variant advertises effort tiers");
      const terra = models.find((candidate) => candidate.id === "cx/gpt-5.6-terra");
      assert.ok(terra, "the Codex Terra base should remain registered");
      assert.equal(terra.thinkingLevelMap?.max, "max", "hiding ultra must not remove Terra's supported max effort");
      assert.equal(models.some((candidate) => candidate.id === "cx/gpt-5.6-sol-ultra"), false, "the synthetic Codex Sol ultra alias should be hidden");
      assert.equal(models.some((candidate) => candidate.id === "cx/gpt-5.6-terra-ultra"), false, "the synthetic Codex Terra ultra alias should be hidden");
      assert.equal(models.some((candidate) => candidate.id === "cx/gpt-5.7-ultra"), true, "other unknown Codex ultra IDs should remain routable");
      assert.equal(models.some((candidate) => candidate.id === "other/gpt-5.6-sol-ultra"), true, "the Codex-only filter should not hide another provider's ultra model");
    } finally {
      await server.close();
    }
  });

  it("does not leak discovery secrets into cache files or fixture data", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "models.json");
      await writeValidCache(cachePath, server.baseUrl);
      configureCacheStartup(server.baseUrl, cachePath, []);

      const harness = createHarness();
      extension(harness.api);
      startSession(harness, "tui");
      await server.waitForResponses(1, "secrets check should still exercise the live refresh path");
      await waitForProviderCount(harness, 2, "secrets check should still exercise the live refresh path");

      const cacheText = await readFile(cachePath, "utf8");
      assert.equal(cacheText.includes("test-key"), false, "cache should not contain the discovery API key");
      assert.equal(cacheText.includes("Authorization"), false, "cache should not contain Authorization headers");
      assert.equal(cacheText.includes("Bearer"), false, "cache should not contain bearer tokens");

      const fixtureText = await readFile(fixturePath, "utf8");
      assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(fixtureText), false, "fixture should not contain secret-like API key strings");
      assert.equal(fixtureText.includes("Authorization"), false, "fixture should not contain Authorization headers");
      assert.equal(fixtureText.includes("Bearer"), false, "fixture should not contain bearer tokens");
    } finally {
      await server.close();
    }
  });

  it("normalizes trailing slashes in OMNIROUTE_BASE_URL and keeps the normalized cache usable", async () => {
    const server = await createFixtureServer();
    try {
      const cachePath = join(tempDir, "models.json");
      await writeValidCache(cachePath, server.baseUrl);
      configureCacheStartup(`${server.baseUrl}/`, cachePath, []);

      const harness = createHarness();
      extension(harness.api);
      startSession(harness, "tui");
      await server.waitForResponses(1, "trailing-slash refresh should finish once and rewrite the cache");
      await waitForProviderCount(harness, 2, "live refresh should complete before checking the normalized cache");

      const cache = JSON.parse(await readFile(cachePath, "utf8"));
      assert.equal(cache.baseUrl, server.baseUrl, "refreshed cache should trim the trailing slash from OMNIROUTE_BASE_URL");
      assert.equal(server.requests, 1, "refresh should still hit the canonical /v1/models endpoint exactly once");

      const nextStartup = createHarness();
      configureCacheStartup(`${server.baseUrl}/`, cachePath, []);
      await extension(nextStartup.api);
      assert.equal(nextStartup.registeredProviders.length, 1, "normalized cache should register immediately on the next cache-hit startup");
      await server.waitForResponses(2, "trailing-slash subsequent startup should complete a second background refresh");
      await waitForProviderCount(nextStartup, 2, "trailing-slash subsequent startup should replace the cached provider after background refresh");
      assert.equal(server.requests, 2, "trailing-slash subsequent startup should issue a second live /models request");
      assert.equal(latestProvider(nextStartup)!.config.baseUrl, server.baseUrl, "subsequent startup should read the normalized baseUrl from cache");
      assert.ok(latestProvider(nextStartup)!.config.models!.length > 100, "subsequent startup should restore the refreshed live catalog from cache");
    } finally {
      await server.close();
    }
  });

  it("writes the default cache path under PI_CODING_AGENT_DIR when OMNIROUTE_MODEL_CACHE_PATH is unset", async () => {
    const server = await createFixtureServer();
    const agentDir = join(tempDir, "agent-dir");
    try {
      const seedCachePath = defaultCachePath(server.baseUrl, agentDir);
      await mkdir(dirname(seedCachePath), { recursive: true });
      await writeValidCache(seedCachePath, server.baseUrl);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      configureCacheStartup(`${server.baseUrl}/`, undefined, []);

      const harness = createHarness();
      extension(harness.api);
      assert.equal(server.requests, 0, "default cache path cache-hit startup should register immediately before background refresh begins");
      assert.deepEqual(modelIds(latestProvider(harness)), ["cached-test-model"], "default cache path cache-hit startup should register the cached provider immediately");

      startSession(harness, "tui");
      await server.waitForResponses(1, "default cache path startup refresh should complete once and write under the agent dir");
      await waitForProviderCount(harness, 2, "default cache path startup refresh should register the live provider");

      const cacheDir = join(agentDir, "omniroute");
      const cacheFiles = await readdir(cacheDir);
      assert.equal(cacheFiles.length, 1, "default cache path should create exactly one cache file for the base URL");
      assert.match(cacheFiles[0]!, /^models-[a-f0-9]{16}\.json$/, "default cache path should hash the normalized base URL into the cache file name");

      const cache = JSON.parse(await readFile(join(cacheDir, cacheFiles[0]!), "utf8"));
      assert.equal(cache.baseUrl, server.baseUrl, "default cache path should store the normalized baseUrl");
      assert.ok(cache.models.length > 100, "default cache path should persist the refreshed live model catalog");
      assert.equal(cache.models.some((model: { id: string }) => model.id === "cached-test-model"), false, "default cache path should not persist the seed cache placeholder");

      const nextStartup = createHarness();
      configureCacheStartup(`${server.baseUrl}/`, join(cacheDir, cacheFiles[0]!), []);
      await extension(nextStartup.api);
      assert.equal(nextStartup.registeredProviders.length, 1, "default cache path should register immediately on the next cache-hit startup");
      await server.waitForResponses(2, "default cache path subsequent startup should complete a second background refresh");
      await waitForProviderCount(nextStartup, 2, "default cache path subsequent startup should replace the cached provider after background refresh");
      assert.equal(server.requests, 2, "default cache path subsequent startup should issue a second live /models request");
      assert.equal(latestProvider(nextStartup)!.config.baseUrl, server.baseUrl, "default cache path should preserve the normalized baseUrl");
      assert.ok(latestProvider(nextStartup)!.config.models!.length > 100, "default cache path should restore the refreshed live catalog");
    } finally {
      await server.close();
    }
  });
});

async function waitForProviderCount(harness: ExtensionHarness, target: number, message: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (harness.registeredProviders.length >= target) return;
    await settleAsyncWork();
  }

  assert.fail(message);
}

async function waitForRefreshedCache(cachePath: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const cache = JSON.parse(await readFile(cachePath, "utf8")) as { models?: unknown[] };
      if (Array.isArray(cache.models) && cache.models.length > 100) return cache;
    } catch {
      // The refresh may still be replacing the cache atomically.
    }
    await settleAsyncWork();
  }

  assert.fail("live discovery should persist the normalized model cache before shutdown completes");
}
