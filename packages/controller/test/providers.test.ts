/**
 * Providers and their keys. plans/48.
 *
 * Keys used to be one environment variable read at boot: one provider at a
 * time, restart to change. They are runtime settings now, and the claims
 * worth pinning are the safety ones — write-only from the outside, file mode
 * clamped, environment always winning — and the one behavioural one: a key
 * added while the app runs takes effect without a restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsFile, keyFor, keySource, setKey, resetCredentialCache }
  from "../src/credentials.ts";
import { PROVIDERS, catalogueOf } from "../src/runtime.ts";
import { startServer } from "../src/server.ts";

test("a stored key is readable back and the file is private to the user", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perp-creds-"));
  credentialsFile(join(dir, "credentials.json"));
  try {
    await setKey("fireworks", "fw-secret-123");
    assert.equal(await keyFor("fireworks", "NO_SUCH_ENV_VAR"), "fw-secret-123");
    assert.equal(await keySource("fireworks", "NO_SUCH_ENV_VAR"), "stored");

    const mode = (await stat(join(dir, "credentials.json"))).mode & 0o777;
    assert.equal(mode, 0o600, "never a moment world-readable");

    await setKey("fireworks", null);
    assert.equal(await keyFor("fireworks", "NO_SUCH_ENV_VAR"), undefined);
  } finally {
    credentialsFile("");
    await rm(dir, { recursive: true, force: true });
  }
});

test("the environment wins over the store, deliberately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perp-creds-env-"));
  credentialsFile(join(dir, "credentials.json"));
  process.env.PERP_TEST_KEY = "from-env";
  try {
    await setKey("openai", "from-store");
    assert.equal(await keyFor("openai", "PERP_TEST_KEY"), "from-env",
      "an exported variable is the most explicit thing on the machine");
    assert.equal(await keySource("openai", "PERP_TEST_KEY"), "env");
  } finally {
    delete process.env.PERP_TEST_KEY;
    credentialsFile("");
    await rm(dir, { recursive: true, force: true });
  }
});

test("the registry holds the mainstream catalogue, each with a key env", () => {
  for (const id of ["anthropic", "fireworks", "openai", "google", "deepseek",
                    "groq", "mistral", "openrouter", "together", "xai"]) {
    assert.ok(PROVIDERS[id], `${id} is a row in the table`);
    assert.match(PROVIDERS[id]!.keyEnv, /_API_KEY$/);
  }
  assert.ok(catalogueOf("anthropic").length > 0, "catalogues resolve without a key");
  assert.equal(catalogueOf("no-such-provider").length, 0);
});

test("the endpoints: facts out, keys in, and never a key back", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-prov-srv-"));
  process.env.PERPETUAL_REPLAY = "1";
  const server = await startServer({ root, port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const list = await (await fetch(`${base}/providers`)).json() as {
      providers: { id: string; hasKey: boolean; source: string | null; models: string[] }[];
    };
    const groq = list.providers.find((x) => x.id === "groq")!;
    assert.ok(groq, "every registry row is listed, keyed or not");
    assert.equal(groq.hasKey, Boolean(process.env.GROQ_API_KEY));

    const set = await (await fetch(`${base}/providers/key`, {
      method: "POST", body: JSON.stringify({ provider: "groq", key: "gk-test" }),
    })).json() as { hasKey: boolean; source: string };
    assert.equal(set.hasKey, true);
    assert.equal(set.source, process.env.GROQ_API_KEY ? "env" : "stored");

    // The whole response surface, searched: the key appears nowhere.
    resetCredentialCache();
    const again = JSON.stringify(await (await fetch(`${base}/providers`)).json());
    assert.ok(!again.includes("gk-test"), "write-only from the outside");

    // And it landed in the store on disk, not in some process variable.
    const disk = await readFile(join(root, "credentials.json"), "utf8");
    assert.ok(disk.includes("gk-test"));

    const bad = await fetch(`${base}/providers/key`, {
      method: "POST", body: JSON.stringify({ provider: "not-a-thing", key: "x" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
    delete process.env.PERPETUAL_REPLAY;
    credentialsFile("");
    await rm(root, { recursive: true, force: true });
  }
});

test("harness knobs round-trip, clamp, and respect the environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-harness-"));
  process.env.PERPETUAL_REPLAY = "1";
  const server = await startServer({ root, port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (body: unknown) =>
    fetch(`${base}/platform`, { method: "POST", body: JSON.stringify(body) });
  const get = async () => (await (await fetch(`${base}/platform`)).json()) as {
    harness: { turnMs: { value: number; source: string }; steps: { value: number };
      jobMs: { value: number }; effort: { value: string; source: string };
      fixed: { label: string; why: string }[] };
  };

  try {
    const before = await get();
    assert.equal(before.harness.turnMs.value, 5 * 60_000);
    assert.equal(before.harness.turnMs.source, "default");
    assert.ok(before.harness.fixed.length >= 5, "the calibrations are shown");
    assert.ok(before.harness.fixed.every((f) => f.why), "each with its why");

    await post({ harness: { turnMs: 15 * 60_000, steps: 80, effort: "high" } });
    const after = await get();
    assert.equal(after.harness.turnMs.value, 15 * 60_000);
    assert.equal(after.harness.turnMs.source, "stored");
    assert.equal(after.harness.effort.value, "high");

    // Clamped at the server, not just in the UI — the bounds are the contract.
    await post({ harness: { turnMs: 60 * 60_000, steps: 500 } });
    const clamped = await get();
    assert.equal(clamped.harness.turnMs.value, 20 * 60_000);
    assert.equal(clamped.harness.steps.value, 80);

    // Nonsense effort refused; env-set effort not the UI's to change.
    assert.equal((await post({ harness: { effort: "maximum" } })).status, 400);
    process.env.PERPETUAL_EFFORT = "low";
    assert.equal((await post({ harness: { effort: "high" } })).status, 409);
    assert.equal((await get()).harness.effort.source, "env");
    delete process.env.PERPETUAL_EFFORT;

    // Back to defaults: null clears, and the file forgets.
    await post({ harness: { turnMs: null, steps: null, effort: null } });
    assert.equal((await get()).harness.turnMs.source, "default");
  } finally {
    await server.close();
    delete process.env.PERPETUAL_REPLAY;
    delete process.env.PERPETUAL_EFFORT;
    await rm(root, { recursive: true, force: true });
  }
});
