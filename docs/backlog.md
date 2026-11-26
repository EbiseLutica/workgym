# バックログ

まだやっていないこと、検証していないこと、レビューで繰り越したことを置く。片付いたものは消す（経緯は git の履歴に残る）。

## tasque-loop

### 未実装

- 中断したランの再開。止まった段階（タスクと、pre・実装・post・レビュー・コミットのどこか）を、`.tasque/current` と verify の結果から判定して続ける。今は「止まったセッションで続ける」しかない
- 人間待ちで LLM を止めない仕組み（キュー、通知）
- インストールスクリプト（`install/`）と、プラグインマーケットプレイスへの登録
- 練習用リポジトリ

### 検討したいこと

- PR のサイズゲートに、承認済みの受け入れテストを数えるか。台帳の記録を作ったラン（2026-11-26-ledg）では、774/500 行のうち約 480 行がテストだった。テストは承認時に人間が読んでいるので、別枠にするか、テストを除いた行数も併記するのがよさそう
- 並列と1体の比較。データが溜まったら方式を決め直す
- 台帳の「その他、実行中に気づいた反省点」。自由記述を入れるなら、書いてよい項目を決める（ledger-sync のスキーマと合わせて）

### 未検証

- PR がマージ済みのワークツリーを `/tasque-loop:clean` で片付ける流れ。gh と remote のある環境で試す（ユニットテストでは PR の状態を差し替えて確かめている）
- ワークツリーの削除に失敗したときに退避のコピーを消す処理（`worktrees.mjs`）。ロックとは別の原因で削除が失敗する状況をテストで作れていない
- POSIX でのプロセスグループごとの kill（`lib/command.mjs`）。この Windows 環境では動かしていない
- サンドボックスを有効にした環境（macOS・Linux・WSL2）での通し実行
- 記録用のスクリプトを組み込んだ後のスキル（`/tasque-loop:run`）の通し実行。組み込みは手で書いた

### レビューで繰り越したもの

tasque で回したランの reviewer が minor / nit として繰り越したもの。

- CLI 全般: `parseArgs` が例外を投げたとき（値のないオプション、知らないオプション）に、使い方を出さずに exit 1 になる。exit 2 にそろえる（escalate・answer・review-feedback・record-review・ledger）
- `approvePlan`: 承認を確定させた後に reviews.json を移すので、移動に失敗すると承認は済んだのに exit 1 になる
- `recordAnswer`: 契約にないタスクでも「未回答がない」というエラーになる（`appendEscalation` は存在を確かめている）
- `record-review.mjs`: BOM 付きの findings ファイルを拒否する。`recordReview`（lib/review.mjs）と `appendReview`（lib/run.mjs）の名前が紛らわしい
- `verifyPost`: 試行履歴を post.json より先に書く。日時を `{ now }` で差し替えられない（ほかの関数の流儀と違う）
- `ledger.mjs`:
  - サブモジュールや bare リポジトリでプロジェクト名がずれる
  - `git init` に失敗すると空のディレクトリが残る
  - `lib/git.mjs` の `repoLayout` を使わずに git を呼んでいる
  - `spawnSync` の `r.error` を見ていない
  - pr.json のパスを自前で組み立てている

## ledger-sync / kaizen-kaigi

- 未着手。全体の構想と作る順番は [overview.md](overview.md) を参照
