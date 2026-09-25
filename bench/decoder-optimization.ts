import { Reader, MAX_SIZE } from "../src/binary.js";
import { invalid } from "../src/errors.js";
import {
  packManifest,
  unpackManifest,
  type ManifestEntry
} from "../src/index.js";
import {
  expectedEntries,
  syntheticManifest,
  type SyntheticOptions
} from "../fixtures/synthetic.js";

/** Controlled reader baseline: identical byte parsing, every result is bigint. */
function alwaysBigIntSize(this: Reader): bigint {
  let value = 0;
  let factor = 1;
  for (let index = 0; index < 7; index++) {
    const next = this.byte();
    value += (next & 127) * factor;
    if (next < 128) {
      if (index > 0 && next === 0) invalid("Nonminimal VarUInt");
      return BigInt(value);
    }
    factor *= 128;
  }
  let wide = BigInt(value);
  for (let index = 7; index < 9; index++) {
    const next = this.byte();
    wide |= BigInt(next & 127) << BigInt(index * 7);
    if (next < 128) {
      if (next === 0) invalid("Nonminimal VarUInt");
      if (wide > MAX_SIZE) invalid("File size exceeds signed bigint");
      return wide;
    }
  }
  return invalid("File-size VarUInt overflow");
}

interface Scenario {
  count: number;
  batch: number;
  options: SyntheticOptions;
}

const scenarios: Record<string, Scenario> = {
  small: {
    count: 20,
    batch: 80,
    options: { pathMode: "legacy", hashKind: "sha256" }
  },
  large: {
    count: 10_000,
    batch: 2,
    options: { pathMode: "legacy", hashKind: "sha256" }
  },
  unicode: {
    count: 1000,
    batch: 8,
    options: { pathMode: "delta", filenames: "utf8", hashKind: "sha256" }
  },
  rsa: {
    count: 1000,
    batch: 8,
    options: { pathMode: "mixed", hashKind: "rsa-v2" }
  }
};

function summary(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples,
    median: sorted[Math.floor(sorted.length / 2)]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!
  };
}

function exactValues(entries: readonly ManifestEntry[]) {
  return JSON.stringify(
    entries.map(({ file_name, s3_path, file_hash, file_size }) => {
      if (file_size === null) throw new Error("Unexpected null fixture size");
      return [file_name, s3_path, file_hash, BigInt(file_size).toString()];
    })
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ready: true });
    const scenarioName = url.searchParams.get("case") ?? "small";
    const scenario = scenarios[scenarioName];
    if (!scenario)
      return Response.json({ error: "Unknown scenario" }, { status: 400 });
    const rows = syntheticManifest(scenario.count, scenario.options);
    const packed = packManifest(rows);
    const expected = exactValues(expectedEntries(rows));
    const current = Reader.prototype.size;
    const variants = { current, alwaysBigInt: alwaysBigIntSize };
    const samples: Record<keyof typeof variants, number[]> = {
      current: [],
      alwaysBigInt: []
    };
    let sink = 0;
    try {
      // Both correctness checks and warmup runs are outside the timed region.
      for (const implementation of Object.values(variants)) {
        Reader.prototype.size = implementation;
        if (exactValues(unpackManifest(packed)) !== expected)
          throw new Error("Tuple mismatch");
        for (let warm = 0; warm < 4; warm++)
          sink += unpackManifest(packed).length;
        Reader.prototype.size = current;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      for (let sample = 0; sample < 13; sample++) {
        const order: (keyof typeof variants)[] =
          sample % 2
            ? ["alwaysBigInt", "current"]
            : ["current", "alwaysBigInt"];
        for (const name of order) {
          Reader.prototype.size = variants[name];
          for (let warm = 0; warm < 2; warm++)
            sink += unpackManifest(packed).length;
          const started = performance.now();
          for (let repeat = 0; repeat < scenario.batch; repeat++)
            sink += unpackManifest(packed).length;
          const elapsed = performance.now() - started;
          if (!(elapsed > 0))
            throw new Error(
              "Runtime clock did not advance; attach the inspector"
            );
          samples[name].push(elapsed / scenario.batch);
          Reader.prototype.size = current;
          // Yield outside timing so native cleanup and unrelated requests can run.
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    } finally {
      Reader.prototype.size = current;
    }
    const currentStats = summary(samples.current);
    const baselineStats = summary(samples.alwaysBigInt);
    const ratio = baselineStats.median / currentStats.median;
    return Response.json({
      scenario: scenarioName,
      count: scenario.count,
      batch: scenario.batch,
      packetBytes: packed.manifest.byteLength,
      samples: 13,
      correctness: true,
      currentMs: currentStats,
      alwaysBigIntMs: baselineStats,
      medianSpeedup: ratio,
      medianReductionPercent: (1 - 1 / ratio) * 100,
      sink
    });
  }
};
