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

interface ExtensionHarness {
  api: ExtensionAPI;
  registeredProviders: RegisteredProvider[];
  readonly registerProviderCalls: number;
  sessionStartHandlers: SessionStartHandler[];
}

interface FixtureServer {
  baseUrl: string;
  readonly requests: number;
  readonly responses: number;
  waitForRequests(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForResponses(target: number, message: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function createHarness(options: { throwOnRegisterAt?: number } = {}): ExtensionHarness {
  const registeredProviders: RegisteredProvider[] = [];
  let registerProviderCalls = 0;
  const sessionStartHandlers: SessionStartHandler[] = [];

  const api = {
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") sessionStartHandlers.push(handler);
    },
    registerProvider(name: string, config: RegisteredProvider["config"]) {
      registerProviderCalls += 1;
      if (options.throwOnRegisterAt === registerProviderCalls) {
        throw new Error(`registerProvider failed for ${name}`);
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

async function createFixtureServer(options: { delayMs?: number; status?: number; body?: string } = {}): Promise<FixtureServer> {
  const fixture = await readFile(fixturePath, "utf8");
  const requestCounter = createWaiterQueue();
  const responseCounter = createWaiterQueue();

  const server = http.createServer(async (req, res) => {
    if (req.url !== "/v1/models") {
      res.writeHead(404).end();
      return;
    }

    requestCounter.increment();
    res.on("finish", () => {
      responseCounter.increment();
    });

    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    res.writeHead(options.status ?? 200, { "content-type": "application/json" });
    res.end(options.body ?? fixture);
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
      return requestCounter.value;
    },
    get responses() {
      return responseCounter.value;
    },
    waitForRequests: (target: number, message: string, timeoutMs?: number) => requestCounter.waitFor(target, message, timeoutMs),
    waitForResponses: (target: number, message: string, timeoutMs?: number) => responseCounter.waitFor(target, message, timeoutMs),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
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
      schemaVersion: 1,
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

  it("does not register cached models for non-interactive startup modes", async () => {
    const server = await createFixtureServer();
    try {
      const cases = [
        { name: "--help", argv: ["--help"] },
        { name: "-h", argv: ["-h"] },
        { name: "--print", argv: ["--print"] },
        { name: "-p", argv: ["-p"] },
        { name: "--mode rpc", argv: ["--mode", "rpc"] },
        { name: "--mode=json", argv: ["--mode=json"] },
      ] as const;

      for (const testCase of cases) {
        const cachePath = join(tempDir, `${testCase.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
        await writeValidCache(cachePath, server.baseUrl);
        configureCacheStartup(server.baseUrl, cachePath, [...testCase.argv]);

        const harness = createHarness();
        assert.doesNotThrow(() => extension(harness.api), `${testCase.name} startup should not throw`);
        assert.equal(server.requests, 0, `${testCase.name} should not hit live discovery before session_start`);
        assert.equal(harness.registeredProviders.length, 0, `${testCase.name} should skip cached model registration`);
      }
    } finally {
      await server.close();
    }
  });

  it("does not register cached models when stdin or stdout is not a TTY", async () => {
    const server = await createFixtureServer();
    try {
      const cases = [
        { name: "stdin non-TTY", stdinTTY: false, stdoutTTY: true },
        { name: "stdout non-TTY", stdinTTY: true, stdoutTTY: false },
      ] as const;

      for (const testCase of cases) {
        const cachePath = join(tempDir, `${testCase.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
        await writeValidCache(cachePath, server.baseUrl);
        configureCacheStartup(server.baseUrl, cachePath, []);
        setTTY(testCase.stdinTTY, testCase.stdoutTTY);

        const harness = createHarness();
        extension(harness.api);
        assert.equal(server.requests, 0, `${testCase.name} should not use the cache or hit live discovery`);
        assert.equal(harness.registeredProviders.length, 0, `${testCase.name} should not use the cache`);
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
          name: "wrong schema version",
          content: createValidCacheJson(validBaseUrl).replace('"schemaVersion": 1', '"schemaVersion": 2'),
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
          content: `${JSON.stringify({ schemaVersion: 1, provider: "omniroute", baseUrl: validBaseUrl, fetchedAt: "2026-06-20T00:00:00.000Z", models: [] }, null, 2)}\n`,
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
              schemaVersion: 1,
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
          assert.equal(normalizedCache.baseUrl, validBaseUrl, `${testCase.name} should write a normalized cache after successful discovery`);
          assert.ok(Array.isArray(normalizedCache.models) && normalizedCache.models.length > 100, `${testCase.name} should persist the normalized live model catalog`);
        }
      });

      assert.ok(warns.some((line) => line.includes("Ignoring invalid model cache") || line.includes("Could not read model cache") || line.includes("VSCode model effort discovery failed")), "invalid cache cases should emit expected warnings");
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
      await extension(harness.api);
      await server.waitForResponses(1, "startup cache-hit refresh should complete before testing non-TUI session_start");
      await waitForProviderCount(harness, 2, "startup cache-hit refresh should replace the cached provider before non-TUI session_start");

      const cacheAfterStartupRefresh = await readFile(cachePath, "utf8");
      startSession(harness, "rpc");
      startSession(harness, "json");

      await expectCountToStayStable(() => server.requests, 1, 100, "non-TUI session_start should not trigger another live /models discovery");
      assert.equal(await readFile(cachePath, "utf8"), cacheAfterStartupRefresh, "non-TUI session_start should not rewrite the cache after the startup refresh");
      assert.ok(latestProvider(harness)!.config.models!.length > 100, "non-TUI session_start should keep the refreshed live provider intact");
    } finally {
      await server.close();
    }
  });

  it("keeps cached provider and cache when discovery returns invalid payloads", async () => {
    const fixtureModels = await readFixtureModels();
    const imageOnlyModel = fixtureModels.find((model) => model.id === "codex/gpt-5.5" && model.type === "image");
    assert.ok(imageOnlyModel, "fixture should include the unusable image-output codex/gpt-5.5 variant");
    assert.equal(
      Array.isArray(imageOnlyModel!.output_modalities) && imageOnlyModel!.output_modalities.includes("text"),
      false,
      "image-output codex/gpt-5.5 should be unusable for text discovery",
    );

    const payloadCases = [
      { name: "invalid JSON", body: "{\"data\": [" },
      { name: "empty data array", body: JSON.stringify({ data: [] }) },
      { name: "unusable non-text payload", body: JSON.stringify({ data: [imageOnlyModel] }) },
    ] as const;

    for (const payloadCase of payloadCases) {
      const server = await createFixtureServer({ body: payloadCase.body });
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
          assert.equal(await readFile(cachePath, "utf8"), originalCache, `${payloadCase.name} should not rewrite the cache on invalid discovery`);
        });

        assert.ok(warns.some((line) => line.includes("Model discovery failed") || line.includes("Ignoring invalid model cache")), `${payloadCase.name} should emit an expected warning`);
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

      const models = latestProvider(harness)!.config.models ?? [];
      const modelById = new Map(models.map((model) => [model.id, model]));

      const textOnly = modelById.get("oc/big-pickle");
      assert.ok(textOnly, "fixture should normalize the text-only Big Pickle model");
      assert.deepEqual(textOnly!.input, ["text"], "text-only models should keep a single text input modality");

      const imageCapable = modelById.get("cx/gpt-5.5");
      assert.ok(imageCapable, "fixture should normalize the GPT 5.5 model");
      assert.deepEqual(imageCapable!.input, ["text", "image"], "image-capable GPT 5.5 should expose both text and image input modalities");
      assert.equal(imageCapable!.reasoning, true, "GPT 5.5 should remain reasoning-capable after normalization");
      assert.deepEqual(
        imageCapable!.thinkingLevelMap,
        {
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        "GPT 5.5 thinking variants should merge into a single semantic provider entry",
      );
      assert.equal(modelById.has("cx/gpt-5.5-low"), false, "thinking variants should merge into the base model instead of appearing separately");
      assert.equal(modelById.has("cx/gpt-5.5-medium"), false, "thinking variants should merge into the base model instead of appearing separately");
      assert.equal(modelById.has("cx/gpt-5.5-high"), false, "thinking variants should merge into the base model instead of appearing separately");
      assert.equal(modelById.has("cx/gpt-5.5-xhigh"), false, "thinking variants should merge into the base model instead of appearing separately");
      assert.equal(modelById.has("codex/gpt-5.5"), true, "the normalized catalog should keep a single GPT 5.5 entry from the usable text-output variant and drop the image-output duplicate");
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
