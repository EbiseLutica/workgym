import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const removed = ["../scripts/worktrees.mjs", "../scripts/lib/worktrees.mjs", "./worktrees.test.mjs"];

test("ワークツリーの一覧と片付けのスクリプト・ライブラリ・テストが削除されている", () => {
  for (const rel of removed) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    assert.equal(existsSync(path), false, `${path} が残っている`);
  }
});
