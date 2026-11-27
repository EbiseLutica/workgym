# workgym

## tasque-loop のスクリプト

テストは `plugins/tasque-loop` で `node --test` を実行する。

### パスの扱い

パスを比較・照合・変換するコードは、`plugins/tasque-loop/scripts/lib/paths.mjs` の関数を使う。`toLowerCase()`・`normalize()`・`realpathSync` などで、比較用の正規化や正式な名前への変換を個別に書かない。足りない処理があれば、`paths.mjs` に足してから使う。

ガードや検査は、パスの照合を拒否する側に倒して行う。同じファイルが別の書き方で指されうるためで、次の違いを想定する。

- 大文字小文字（大文字小文字を区別しないファイルシステム）
- Unicode の正規化（macOS の NFD など）
- Windows の別名（8.3 形式の短い名前、代替データストリーム、末尾のドットや空白）

照合する側（ガード・検査・MCP サーバー）のどれか1つでも別の正規化をすると、その差がすり抜けの穴になる。実際に、ガードは正式な名前で判定していたのに、MCP サーバーは渡された名前のまま git に問い合わせていて、追跡済みのファイルを別名で消せた。

使い分け:

- 「同じファイルを指しうるか」の比較（保護パス、受け入れテストの照合など）: `toNfcLowerPath`・`isSamePath`
- ツールに渡されたパスの解決: `absolutize`・`canonicalize`・`toProjectRelative`・`isInside`
- 別名になりうる書き方の検出: `rawComponents`・`suspiciousComponent`。正規化の前の入力そのものにも使う（realpath は代替データストリームや末尾のドットを黙って落とすため）
- cwd に依存しない絶対パスか: `isFullyAbsolute`
- 実在する2つのディレクトリが同じか: `isSameDir`
- 契約や設定に書くパスの形式検査: `canonicalPathError`（正規形か）・`portablePathError`（どの OS でも扱える名前か）
