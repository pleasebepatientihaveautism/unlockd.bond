import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface UsageState {
  version: 1;
  attemptedCalls: number;
  successfulCalls: number;
  updatedAt: string;
}

export interface BudgetReservation {
  allowed: boolean;
  remainingCalls: number;
}

const initialState = (): UsageState => ({
  version: 1,
  attemptedCalls: 0,
  successfulCalls: 0,
  updatedAt: new Date(0).toISOString()
});

export class PersistentApiBudget {
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maximumCalls: number,
    private readonly reservedCalls: number
  ) {}

  reserveNetworkCall(): Promise<BudgetReservation> {
    return this.exclusive(async () => {
      const state = await this.read();
      const remaining = Math.max(0, this.maximumCalls - state.attemptedCalls);
      if (remaining <= this.reservedCalls) {
        return { allowed: false, remainingCalls: remaining };
      }
      const next = {
        ...state,
        attemptedCalls: state.attemptedCalls + 1,
        updatedAt: new Date().toISOString()
      };
      await this.write(next);
      return {
        allowed: true,
        remainingCalls: Math.max(0, this.maximumCalls - next.attemptedCalls)
      };
    });
  }

  markSuccessfulCall(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.read();
      await this.write({
        ...state,
        successfulCalls: state.successfulCalls + 1,
        updatedAt: new Date().toISOString()
      });
    });
  }

  remainingCalls(): Promise<number> {
    return this.exclusive(async () => {
      const state = await this.read();
      return Math.max(0, this.maximumCalls - state.attemptedCalls);
    });
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operation.then(task, task);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async read(): Promise<UsageState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<UsageState>;
      if (
        parsed.version !== 1 ||
        !Number.isInteger(parsed.attemptedCalls) ||
        !Number.isInteger(parsed.successfulCalls) ||
        (parsed.attemptedCalls ?? -1) < 0 ||
        (parsed.successfulCalls ?? -1) < 0
      ) {
        return {
          version: 1,
          attemptedCalls: this.maximumCalls,
          successfulCalls: 0,
          updatedAt: new Date().toISOString()
        };
      }
      return {
        version: 1,
        attemptedCalls: parsed.attemptedCalls ?? 0,
        successfulCalls: parsed.successfulCalls ?? 0,
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString()
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
      throw error;
    }
  }

  private async write(state: UsageState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.filePath);
  }
}
