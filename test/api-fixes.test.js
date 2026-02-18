import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/githubServerFactory.js", import.meta.url),
  "utf-8",
);

test("encodePathSegments helper exists", () => {
  assert.match(src, /function encodePathSegments/);
});

test("no encodeURIComponent on full cleanPath", () => {
  assert.ok(
    !src.includes("encodeURIComponent(cleanPath)"),
    "Should not have encodeURIComponent applied to full path strings",
  );
});

test("fetchAllItems accepts maxPages parameter", () => {
  assert.match(src, /maxPages/);
});

test("parseRepoUrl returns raw owner and repo without encoding", () => {
  // Extract just the return block inside parseRepoUrl
  const returnMatch = src.match(
    /function parseRepoUrl[\s\S]*?return\s*\{([^}]+)\}/,
  );
  assert.ok(
    returnMatch,
    "parseRepoUrl function with return block should exist",
  );
  assert.ok(
    !returnMatch[1].includes("encodeURIComponent"),
    "parseRepoUrl should return raw values — encoding belongs at URL construction sites",
  );
});

test("no dead catch-rethrow blocks remain", () => {
  // Check that the pattern catch(error){throw error} doesn't appear
  const deadCatchPattern =
    /catch\s*\(\s*error\s*\)\s*\{\s*throw\s+error\s*;?\s*\}/;
  assert.ok(
    !deadCatchPattern.test(src),
    "Dead catch(error){throw error} blocks should be removed",
  );
});

test("rate limit handling exists", () => {
  assert.ok(
    src.includes("x-ratelimit-remaining"),
    "Should check x-ratelimit-remaining header",
  );
});
