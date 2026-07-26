import { chmodSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = path.resolve(".env.coresignal.local");
const temporaryPath = `${outputPath}.tmp`;

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      process.stdin.removeListener("data", onData);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("CANCELLED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

const apiKey = await readHidden("Coresignal API key (hidden; stored locally only): ");
if (!apiKey) throw new Error("CORESIGNAL_API_KEY_REQUIRED");

const contents = [
  `CORESIGNAL_API_KEY=${apiKey}`,
  "CORESIGNAL_COLLECT_URL_TEMPLATE=https://api.coresignal.com/cdapi/v2/company_multi_source/enrich?website=https%3A%2F%2F{companyIdentifier}",
  "CORESIGNAL_CACHE_DIR=cache/companies",
  "CORESIGNAL_USAGE_FILE=api-usage.json",
  "CORESIGNAL_MAX_CALLS=100",
  "CORESIGNAL_RESERVED_CALLS=10",
  "CORESIGNAL_CACHE_TTL_SECONDS=604800",
  ""
].join("\n");

writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, outputPath);
chmodSync(outputPath, 0o600);

process.stdout.write(
  "Coresignal configured in ignored .env.coresignal.local with file mode 0600.\n"
);
