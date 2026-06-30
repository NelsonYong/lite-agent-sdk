import { expect, test } from "vitest";
import { SteerController } from "../src/steer";

test("SteerController normalizes strings to user messages and drains once", () => {
  const s = new SteerController();
  s.steer("a");
  s.steer({ role: "user", content: "b" });
  s.followUp("c");
  expect(s.takeSteers()).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  expect(s.takeSteers()).toEqual([]); // drained
  expect(s.takeFollowUps()).toEqual([{ role: "user", content: "c" }]);
  expect(s.takeFollowUps()).toEqual([]);
});
