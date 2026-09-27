import assert from "node:assert/strict";
import { test } from "node:test";
import { decompress, type Tuning } from "../src/lzma.ts";

const packed = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

const TEXT =
  "ADkcqsON2++3yl6nc8437xYlvReC8Lc4DhXkGK0jd0XWd7oV2B7bKtLHDGBZ4LnBbW7YhisBpuzVLy5F" +
  "j7iKBfUE0gkaumUnKGj4g1Ej4xGS5oJgXBUOK+QEmJhAzW26ggI5HVwnrpMImCrWSFAW21h77l6x8/zq" +
  "ZTXeCTVSDO4o/Tq7KWU9IpXItVE+8IaNyOs/+iEpxDVhs6E8+RkNSFifVD+LQmMxbXPOwMirevg/kY+q" +
  "Bl2UWUtLLbi5IetiBPWm2nZjjZh2ihxF5Z9xpyzjT8T4CVbQ6IMxg7g8W//+CHwA";

const NOISE =
  "ACCnh67dSYd03ZGGYrAulMUt4XgF0UbnxeUDpf0VmMt12S92W7xYg/iqgCvJmMjydirD9koKtFcONaml" +
  "XU/fYXWblPEzeiP9e/PCEdwYdIZ7GDFvZYNQDpRa/uN4OTAm8aYkki5IPfxt3awRmMSkZt2wojSLPvJT" +
  "ZyhvSwDF6AgQXPUeyx/h+Q3G3CHvuPfhWtoevga4+xAlLCW34BfSBEdGXtRyDCamFKpjM9o2Chwv6DEP" +
  "OCVCWXGYaeRmeAmC4lDqOy/zsV7TS3P1UrUqr0D///1nkAA=";

const COLUMN =
  "AABouiDRAQNQcK1z7GFYBFJlJ6YWY6HNuwBcYRQGZANiliHGLwr7xe3AyJp7b7jUILJsUlG6RO7fsL6C" +
  "zwVy+ckumnmQe9iu2+ehTR9pSptJhgKyOezuaWE+N46bjUdavSsTgoi6nZ58m/TzeAAomb5Ory/kzHFA" +
  "v4zQGV07pX7F4d34hWYf1lNgCAs258YfZKb09ZWd3mwoi3bgZQ7EydMexDRrm45bl/E9757SF9sij5ti" +
  "ujeIt8B8biaHbm+oW6rNsT5ZpX4DJ0abLAmcWHSve3MZm8Sr6QiFXSnoEDxchyYYPSAUZqe+RtpSbj7+" +
  "07O3qlnp22J+LH47MOmAojm1MkuOSWOkEN26ClMvybxbRzCQO4YTl34Ob3U2OkVhEWL66LS3c2/9tDks" +
  "fOW1xUk6gPJsta/2B1n561fZ8viU0zbsLk+lv9LM298ZheQxSI6KNrWKqfFDT4djjg9pkVsZMIraXHHZ" +
  "xXT1EkSqmPARDYr5rAJgT3SiEvTT/m0SXrxlgDybXGHHWfetN63b4u9tVYUO/MNBuoPqxgoplN2PjVUn" +
  "dThC3p/+u2FkirWig4d2o7G1ly+tR39GMYJaXOnfRfQwGyQXK3DNl9NO6GNLGtDOEuvOQSkOnS5rlMZa" +
  "sHSBmg1M/4sCGzRIe6KIpRHZ4L6s/QUakdfEkEzYpcoyjg4+dMPy+lHzarX+mRp8y0EiKFf5M/vs1+DQ" +
  "Pvnk2ugmxF6q4buriT6Jf4XUJtgg1pJarV5DOgnTw3UngIZRLZuOYeyIkg6TbfVRpREa8//51ly0cKnU" +
  "hxEF8s9XmcxZtiyWhG2P4XKI/RPJolw8S3Ly52Lsr7/F+XrttXqF18fJ3ub1//+3KAAA";

const PLAIN: Tuning = [3, 0, 0];

test("reads back an empty stream", () => {
  assert.deepEqual(decompress(packed("AIP/+///wAAAAA=="), PLAIN), new Uint8Array(0));
});

test("reads back text full of repeats", () => {
  const text = Array.from({ length: 4000 }, (_, at) => `row ${at % 97} of the pool\n`);
  assert.deepEqual(
    decompress(packed(TEXT), PLAIN),
    new TextEncoder().encode(text.join("")),
  );
});

test("reads back bytes with nothing to match", () => {
  let seed = 1;
  const noise = Uint8Array.from({ length: 200 }, () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 24;
  });
  assert.deepEqual(decompress(packed(NOISE), [0, 0, 0]), noise);
});

test("reads back a column tuned to where a byte sits in its value", () => {
  const column = new DataView(new ArrayBuffer(1200));
  for (let at = 0; at < 300; at += 1) {
    column.setUint32(at * 4, ((at * 7919) % 50000) + (at % 3) * 65536, true);
  }
  assert.deepEqual(decompress(packed(COLUMN), [0, 2, 2]), new Uint8Array(column.buffer));
});

test("refuses what is not a stream", () => {
  assert.throws(() => decompress(Uint8Array.of(1, 0, 0, 0, 0), PLAIN), /not a stream/);
  assert.throws(() => decompress(packed(TEXT).subarray(0, 40), PLAIN), /ends early/);
});
