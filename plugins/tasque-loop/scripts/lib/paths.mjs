import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

/**
 * パスの比較・照合・変換をまとめたライブラリ。パスを扱うコードは、比較用の正規化や正式な名前への変換を自前で書かず、ここを使う。
 * 照合は拒否する側に倒す。大文字小文字を区別しないファイルシステム、Unicode の正規化の違い（macOS の NFD など）、
 * Windows の別名（8.3 形式の短い名前、代替データストリーム、末尾のドットや空白）で、別の書き方が同じファイルを指しうるため。
 */

/**
 * 比較用に正規化した形（NFC にして小文字にする）。保護パスの判定など、「同じファイルを指しうるか」で照合するときに使う。
 */
export function toNfcLowerPath(p) {
  return p.normalize("NFC").toLowerCase();
}

/**
 * 2つのパスが同じファイルを指しうるかを返す。拒否側に倒して照合する（toNfcLowerPath で比べる）。
 */
export function isSamePath(a, b) {
  return toNfcLowerPath(a) === toNfcLowerPath(b);
}

/**
 * 2つの実在するディレクトリが同じかを返す。どちらも realpath で正式な名前に直し、Windows では大文字小文字を無視して比べる。
 * 実在しないパスは例外。
 */
export function isSameDir(a, b) {
  const norm = (p) => {
    const real = realpathSync.native(p);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

/**
 * ドライブやルートまで含む絶対パスか。Windows ではドライブ文字つきだけを絶対パスとみなす
 * （"\foo" のようなドライブを省いたパスは、解決する側の cwd によって指す場所が変わるため）。
 */
export function isFullyAbsolute(p) {
  if (typeof p !== "string" || p === "") return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(p);
  return isAbsolute(p);
}

/**
 * ツールと同じ解釈で絶対パスにする。先頭の ~ はホームディレクトリ、相対パスは base から解決する。
 */
export function absolutize(p, base) {
  if (p === "~" || /^~[\\/]/.test(p)) return resolve(homedir(), p.slice(2));
  return resolve(base, p);
}

/**
 * 実在する最も深い祖先を realpath で正式な名前（長い名前・実際の大文字小文字）にし、残りを付け直す。
 */
export function canonicalize(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * ツールに渡されたパスをプロジェクトルートからの POSIX 相対パスにする。外を指す場合とルート自身は null。
 * 相対パスは base（既定はプロジェクトルート）から解決し、実在する部分は正式な名前に揃える。
 */
export function toProjectRelative(projectDir, p, base = projectDir) {
  const rel = relative(canonicalize(resolve(projectDir)), canonicalize(absolutize(p, base)));
  if (rel === "" || isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
  return sep === "\\" ? rel.replaceAll("\\", "/") : rel;
}

/**
 * パスが root の中か。相対パスは base（既定は root）から解決し、どちらも正式な名前に揃えてから比べる。
 * allowRoot なら root 自身も中とみなす。
 */
export function isInside(root, p, { allowRoot = false, base = root } = {}) {
  const rel = relative(canonicalize(resolve(root)), canonicalize(absolutize(p, base)));
  if (rel === "") return allowRoot;
  return !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
}

/**
 * 入力されたパス文字列の要素。先頭のドライブ指定（C:）は要素として扱わない。
 */
export function rawComponents(raw) {
  const parts = raw.split(/[\\/]+/);
  if (/^[A-Za-z]:/.test(parts[0])) parts[0] = parts[0].slice(2);
  return parts;
}

/**
 * 別名になりうる要素を返す。なければ null。
 * - ":" を含む（NTFS の代替データストリーム）
 * - 末尾がドットか空白（Windows が黙って取り除く）
 * - shortName なら "~数字" を含む（8.3 形式の短い名前）
 * realpath は代替データストリームや末尾のドットを黙って落とすことがあるため、入力そのままの要素（rawComponents）にも使う。
 * 入力そのままの要素では、正式な名前にも "~数字" はありうるので shortName を付けない。
 */
export function suspiciousComponent(parts, { shortName }) {
  return (
    parts.find(
      (c) =>
        c !== "" &&
        c !== "." &&
        c !== ".." &&
        (c.includes(":") || /[.\s]$/.test(c) || (shortName && /~\d/.test(c))),
    ) ?? null
  );
}

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * 契約や設定に書くプロジェクト相対パスの正規形を検査し、問題があればメッセージを返す。正規形なら null。
 * 照合は文字列のまま行うため、`./` や `//`、末尾の `/` などの書き方の揺れは黙って直さずに拒否する。
 * glob: false なら glob の特殊文字も拒否する（テストファイルや作業ディレクトリのように1つのパスを指すもの）。
 */
export function canonicalPathError(p, { glob = true } = {}) {
  if (p.includes("\\")) return "区切りは / を使う";
  if (posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return "プロジェクトルートからの相対パスにする";
  const parts = p.split("/");
  if (parts.includes("..")) return ".. は使えない";
  if (parts.includes(".")) return ". は使えない（先頭の ./ も書かない）";
  if (parts.includes("")) return "空の要素がある（// や末尾の / を書かない）";
  if (!glob && GLOB_CHARS.test(p)) return "glob の特殊文字（* ? [ ] { }）は使えない";
  return null;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * プロジェクト相対パスが、どの OS でも同じファイルとして扱える名前かを確かめる。問題がなければ null。
 * POSIX で作れても Windows で扱えない名前（git に載せると Windows で壊れる）を止める。
 * - Windows で使えない文字（\ : * ? " < > | と制御文字）
 * - 末尾のドットや空白
 * - Windows の予約名（CON、NUL、COM1 など。拡張子つきも含む）
 */
export function portablePathError(p) {
  for (const part of p.split("/")) {
    if (/[\\:*?"<>|\x00-\x1f]/.test(part)) return `「${part}」に Windows で使えない文字がある`;
    if (/[.\s]$/.test(part) && part !== "." && part !== "..") return `「${part}」がドットか空白で終わる`;
    if (WINDOWS_RESERVED.test(part)) return `「${part}」は Windows の予約名`;
  }
  return null;
}
