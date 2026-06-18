import { expect, test } from "vitest";
import { createAgent, nativeCodec, fakeProvider, textBlock } from "../src/index";

test("public API: createAgent + nativeCodec + fakeProvider run end to end", async () => {
  const agent = createAgent({
    model: fakeProvider([{ text: "ok", message: { role: "assistant", content: [textBlock("ok")] } }]),
    codec: nativeCodec(),
  });
  const result = await agent.send("hi");
  expect(result.text).toBe("ok");
});
