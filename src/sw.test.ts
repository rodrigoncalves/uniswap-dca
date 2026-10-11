import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// F11: the service worker may only cache the static shell, never /api/* or
// any authenticated response (invariant 6: stale data must not look live).
test("sw.js: the cached shell list excludes /api/* and every path is a served static file", () => {
  const src = readFileSync("public/sw.js", "utf8");
  const shell = JSON.parse(/const SHELL = (\[.*?\]);/s.exec(src)![1]!) as string[];
  assert.ok(shell.length > 0);
  for (const path of shell) assert.ok(!path.startsWith("/api"), `${path} must not be cached`);
  const server = readFileSync("src/server.ts", "utf8");
  for (const path of shell) if (path !== "/") assert.ok(server.includes(`"${path}"`), `${path} is not served`);
  assert.doesNotMatch(src, /caches\.open\([^)]*\)\.then\([^)]*put\([^)]*\/api/);
});

test("manifest: standalone with 192, 512 and a maskable icon", () => {
  const m = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  assert.ok(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable"));
});
