import assert from "node:assert/strict";
import { test } from "node:test";
import { AssuranceInputError, validateAssuranceImage } from "../src/assurance.js";

test("accepts supported image formats only when file signatures match", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const webp = Buffer.from("RIFF0000WEBP", "ascii");

  assert.equal(validateAssuranceImage(png, "image/png").extension, "png");
  assert.equal(validateAssuranceImage(jpeg, "image/jpeg").extension, "jpg");
  assert.equal(validateAssuranceImage(webp, "image/webp").extension, "webp");
  assert.throws(() => validateAssuranceImage(png, "image/jpeg"), AssuranceInputError);
  assert.throws(() => validateAssuranceImage(Buffer.from("not an image"), "image/png"), AssuranceInputError);
  assert.throws(() => validateAssuranceImage(png, "image/svg+xml"), AssuranceInputError);
  assert.throws(() => validateAssuranceImage(Buffer.alloc(0), "image/png"), AssuranceInputError);
});
