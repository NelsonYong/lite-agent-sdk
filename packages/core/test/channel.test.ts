import { expect, test } from "vitest";
import { channel } from "../src/channel";

test("channel yields pushed values in order then ends", async () => {
  const ch = channel<number>();
  ch.push(1); ch.push(2);
  queueMicrotask(() => { ch.push(3); ch.end(); });
  const got: number[] = [];
  for await (const v of ch) got.push(v);
  expect(got).toEqual([1, 2, 3]);
});

test("channel surfaces an end error to the consumer", async () => {
  const ch = channel<number>();
  ch.push(1);
  ch.end(new Error("boom"));
  const got: number[] = [];
  await expect((async () => { for await (const v of ch) got.push(v); })()).rejects.toThrow("boom");
  expect(got).toEqual([1]);
});
