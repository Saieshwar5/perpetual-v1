/**
 * `pnpm models [provider] [filter]` — what can I actually run?
 *
 * The catalogue is baked into pi-ai, so this needs no key and no network. It
 * exists because choosing a model is the first real decision when pointing
 * this at a provider, and guessing an id costs a failed start.
 */
import { createModels } from "@earendil-works/pi-ai";
import { PROVIDERS } from "./runtime.ts";

const [providerId = "anthropic", filter] = process.argv.slice(2);
const entry = PROVIDERS[providerId];
if (!entry) {
  console.error(`Unknown provider "${providerId}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
  process.exit(1);
}

const models = createModels();
models.setProvider(entry.make());

const rows = models.getModels(providerId)
  .filter((m) => !filter || m.id.includes(filter))
  .map((m) => ({
    short: m.id.replace(entry.prefix ?? "", ""),
    ctx: m.contextWindow ?? 0,
    inCost: m.cost?.input ?? 0,
    outCost: m.cost?.output ?? 0,
    api: m.api,
  }))
  .sort((a, b) => a.inCost - b.inCost);

console.log(`\n  ${providerId} — ${rows.length} models   (key: ${entry.keyEnv})`);
console.log(`  default: ${entry.defaultModel.replace(entry.prefix ?? "", "")}\n`);
console.log(`  ${"model".padEnd(42)}${"context".padStart(10)}${"$in/M".padStart(9)}${"$out/M".padStart(9)}  api`);
for (const r of rows) {
  console.log(
    `  ${r.short.slice(0, 41).padEnd(42)}` +
    `${(r.ctx / 1000).toFixed(0).padStart(9)}k` +
    `${r.inCost.toFixed(2).padStart(9)}${r.outCost.toFixed(2).padStart(9)}  ${r.api}`,
  );
}
console.log(`\n  PERPETUAL_PROVIDER=${providerId} PERPETUAL_MODEL=<model> pnpm dev\n`);
