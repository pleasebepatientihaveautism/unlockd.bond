import "dotenv/config";
import { createRuntime } from "../src/server/runtime.js";

const { app } = createRuntime();

export default app;
