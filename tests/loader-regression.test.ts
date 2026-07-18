import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const extensionPath = join(projectRoot, "index.ts");

const BASE_URL = "https://omniroute.test";
const ENV_KEYS = ["OMNIROUTE_BASE_URL", "OMNIROUTE_MODEL_CACHE_PATH", "PI_OFFLINE"] as const;

function createValidCacheJson(baseUrl: string) {
  return `${JSON.stringify(
    {
      schemaVersion: 2,
      provider: "omniroute",
      baseUrl,
      fetchedAt: "2026-06-20T00:00:00.000Z",
      models: [
        {
          id: "loader-regression-model",
          name: "Loader Regression Model",
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

describe("Pi extension loader regression", () => {
  let tempDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omniroute-loader-test-"));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

    process.env.OMNIROUTE_BASE_URL = BASE_URL;
    process.env.OMNIROUTE_MODEL_CACHE_PATH = join(tempDir, "models-cache.json");
    process.env.PI_OFFLINE = "1";
    await writeFile(process.env.OMNIROUTE_MODEL_CACHE_PATH, createValidCacheJson(BASE_URL));
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads the real index.ts through the Pi loader and registers the omniroute provider", async () => {
    const result = await discoverAndLoadExtensions([extensionPath], tempDir, join(tempDir, "agent"));

    assert.deepEqual(
      result.errors,
      [],
      `Pi loader should load index.ts without errors: ${JSON.stringify(result.errors)}`,
    );

    const provider = result.runtime.pendingProviderRegistrations.find(
      (registration) => registration.name === "omniroute",
    );
    assert.ok(provider, "omniroute provider should be queued for registration");
    assert.equal(provider.config.api, "openai-responses");
    assert.equal(
      provider.config.streamSimple,
      undefined,
      "OmniRoute should delegate Responses streaming and reasoning rendering to Pi",
    );
  });
});
