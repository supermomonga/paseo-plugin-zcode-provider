import { expect, test } from "vitest";
import {
  ModelSelectionViewSchema,
  SessionSnapshotSchema,
} from "./host/schemas.js";
import { snapshot } from "../test/fake-host.js";
test("accepts lifecycle metadata before a model is selected", () => {
  const value = snapshot("/workspace");
  delete value.settings.model.current;
  expect(SessionSnapshotSchema.safeParse(value).success).toBe(true);
});
test("does not admit credential-bearing provider records into the projected catalog", () => {
  expect(
    ModelSelectionViewSchema.safeParse({
      revision: 0,
      models: [],
      providers: [{ apiKey: "sentinel" }],
    }).success,
  ).toBe(false);
});
