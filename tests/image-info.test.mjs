import assert from "node:assert/strict";
import test from "node:test";

import { imageDimensions } from "../lib/image-info.mjs";
import { makePng } from "./support.mjs";

test("reads PNG dimensions from the IHDR header", () => {
  assert.deepEqual(imageDimensions(makePng(640, 480)), { width: 640, height: 480 });
});

test("returns null for unknown or truncated data", () => {
  assert.equal(imageDimensions(Buffer.from("not an image")), null);
  assert.equal(imageDimensions(makePng(64, 64).subarray(0, 16)), null);
  assert.equal(imageDimensions(null), null);
});
