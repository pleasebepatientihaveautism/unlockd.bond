import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheEnvelope {
  fetchedAt: string;
  raw: unknown;
}

export interface CacheReadResult {
  raw: unknown;
  fetchedAt: string;
  stale: boolean;
}

function cacheKey(companyIdentifier: string): string {
  const normalized = companyIdentifier.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

export class CompanyFileCache {
  constructor(
    private readonly directory: string,
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now
  ) {}

  async read(companyIdentifier: string): Promise<CacheReadResult | null> {
    try {
      const envelope = JSON.parse(
        await readFile(this.filePath(companyIdentifier), "utf8")
      ) as Partial<CacheEnvelope>;
      if (typeof envelope.fetchedAt !== "string" || !("raw" in envelope)) return null;
      const fetchedAtMs = Date.parse(envelope.fetchedAt);
      if (!Number.isFinite(fetchedAtMs)) return null;
      return {
        raw: envelope.raw,
        fetchedAt: envelope.fetchedAt,
        stale: this.now() - fetchedAtMs > this.ttlSeconds * 1000
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  async write(companyIdentifier: string, raw: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = this.filePath(companyIdentifier);
    const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const envelope: CacheEnvelope = {
      fetchedAt: new Date(this.now()).toISOString(),
      raw
    };
    await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, destination);
  }

  private filePath(companyIdentifier: string): string {
    return path.join(this.directory, `${cacheKey(companyIdentifier)}.json`);
  }
}
