import { nodeSqlite } from "../src/node-sqlite.js";
/** node:sqlite for tests (the phone uses expo-sqlite with the same interface). */
export const nodeDb = (path = ":memory:") => nodeSqlite(path);
