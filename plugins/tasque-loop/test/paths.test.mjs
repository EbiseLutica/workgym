import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isFullyAbsolute,
  isInside,
  isSamePath,
  rawComponents,
  suspiciousComponent,
  toNfcLowerPath,
  toProjectRelative,
} from "../scripts/lib/paths.mjs";

test("toNfcLowerPath・isSamePath は大文字小文字と Unicode 正規化の違いを同一視する", () => {
  assert.equal(toNfcLowerPath("Src/CLAUDE.md"), "src/claude.md");
  assert.equal(toNfcLowerPath("test/か\u3099.ts"), toNfcLowerPath("test/が.ts"));
  assert.equal(isSamePath("Test/A.ts", "test/a.ts"), true);
  assert.equal(isSamePath("test/a.ts", "test/b.ts"), false);
});

test("isFullyAbsolute はドライブやルートまで含むパスだけを絶対パスとみなす", () => {
  assert.equal(isFullyAbsolute("src/a.ts"), false);
  assert.equal(isFullyAbsolute(""), false);
  assert.equal(isFullyAbsolute(undefined), false);
  if (process.platform === "win32") {
    assert.equal(isFullyAbsolute("C:\\repo\\a.ts"), true);
    assert.equal(isFullyAbsolute("C:/repo/a.ts"), true);
    assert.equal(isFullyAbsolute("\\repo\\a.ts"), false);
    assert.equal(isFullyAbsolute("C:repo\\a.ts"), false);
  } else {
    assert.equal(isFullyAbsolute("/repo/a.ts"), true);
  }
});

test("suspiciousComponent は代替データストリーム・末尾のドットや空白・短い名前を見つける", () => {
  const raw = (p) => suspiciousComponent(rawComponents(p), { shortName: false });
  assert.equal(raw("C:\\repo\\a.ts"), null);
  assert.equal(raw("C:\\repo\\a.ts:hidden"), "a.ts:hidden");
  assert.equal(raw("/repo/a.ts."), "a.ts.");
  assert.equal(raw("/repo/a.ts "), "a.ts ");
  assert.equal(raw("/repo/LONGFI~1.TS"), null);
  assert.equal(suspiciousComponent(["src", "LONGFI~1.TS"], { shortName: true }), "LONGFI~1.TS");
  assert.equal(suspiciousComponent(["..", ".", "src"], { shortName: true }), null);
});

test("toProjectRelative・isInside は実在する部分を正式な名前に揃えて判定する", () => {
  const dir = mkdtempSync(join(tmpdir(), "tasque-paths-"));
  mkdirSync(join(dir, "Src"));
  writeFileSync(join(dir, "Src", "Foo.ts"), "");
  if (process.platform === "win32") {
    assert.equal(toProjectRelative(dir, join(dir, "SRC", "FOO.TS")), "Src/Foo.ts");
    assert.equal(toProjectRelative(dir, join(dir, "SRC", "new.ts")), "Src/new.ts");
  }
  assert.equal(toProjectRelative(dir, "Src/Foo.ts"), "Src/Foo.ts");
  assert.equal(isInside(dir, join(dir, "Src", "Foo.ts")), true);
  assert.equal(isInside(dir, dir), false);
  assert.equal(isInside(dir, dir, { allowRoot: true }), true);
  assert.equal(isInside(dir, join(dir, "..", "x")), false);
});
