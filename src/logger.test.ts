import { test } from "node:test";
import assert from "node:assert/strict";
import { logger, registerSecret } from "./logger.js";

test("logger: an undefined field is skipped, not a crash (it used to throw inside redact)", (t) => {
  registerSecret("some-registered-secret"); // production always has some -- redact() only loops when it does
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  assert.doesNotThrow(() => logger.info("swap broadcast", { txHash: "0xabc", manualId: undefined }));
  assert.match(lines[0]!, /"txHash":"0xabc"/);
  assert.doesNotMatch(lines[0]!, /manualId/);
});
