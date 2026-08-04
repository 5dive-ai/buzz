import assert from "node:assert/strict";
import test from "node:test";

import { deriveMeshMemoryModel } from "./meshMemoryModel.ts";

const catalog = {
  gpuName: "Apple GPU",
  vramDisplay: "32 GB",
  vramGb: 32,
  recommended: "gemma",
  entries: [
    {
      name: "gemma",
      size: "8GB",
      sizeGb: 8,
      description: "",
      fit: "comfortable",
      installed: true,
      recommended: true,
      curated: true,
    },
  ],
};

test("prefers the runtime's reported model footprint", () => {
  const model = deriveMeshMemoryModel({
    view: {
      connected: true,
      selfCapacityGb: 40,
      selfModelSizeGb: 10,
      peers: [],
    },
    catalog,
    modelRef: "gemma",
  });
  assert.equal(model.label, "10 GB of 40 GB AI memory used by model");
  assert.equal(model.usedSegments, 3);
});

test("falls back to the selected catalog model before runtime status arrives", () => {
  const model = deriveMeshMemoryModel({
    view: null,
    catalog,
    modelRef: "gemma",
  });
  assert.equal(model.label, "8 GB of 32 GB AI memory used by model");
  assert.equal(model.usedSegments, 3);
});

test("unknown model size shows available memory without inventing use", () => {
  const model = deriveMeshMemoryModel({
    view: null,
    catalog,
    modelRef: "custom/model",
  });
  assert.equal(model.label, "32 GB AI memory available");
  assert.equal(model.usedSegments, 0);
});
