# tasque-loop

機能要件をタスク契約に分割し、契約ごとに受け入れテストを先に書かせてから実装させるための Claude Code プラグインです。契約・許可リストのフック・検査スクリプト（verify）で、implementer が契約の外を書き換えたりテストを書き換えたりしていないことを機械的に確かめます。

```
/plugin install tasque-loop --marketplace ebiselutica/workgym
```

`/tasque-loop:run <要件>` で、下の流れをメインエージェントが進行します（要件は GitHub issue の URL・番号、本文テキスト、仕様ファイルのパス）。仕様は [docs/tasque-loop.md](../../docs/tasque-loop.md) にあります。

## 流れ

1. worktree（作業ブランチ）を作った直後に `verify --phase baseline` を走らせ、基点を記録する
2. planner が `.tasque/plan.draft.json`（契約の下書き）と受け入れテストを書く。SubagentStop フックが下書きを検査し、不正なら差し戻す（最大2回）。結果は `.tasque/plan.draft.check.json`
3. `verify --phase red` で、実装前の受け入れコマンドが落ちることを確かめる。結果は `.tasque/plan.draft.red.json`
4. 人間が契約・テスト・Red 確認の出力をレビューする。直してほしい点があれば planner に戻して 2 からやり直す
5. 人間が承認したら、メインエージェントが人間の言葉をそのまま `uncertain` の `decision` に書き、`approve.mjs` で承認する。続けて、契約の `tests` に挙げたパスだけを明示してテストをコミットする
6. タスクごとに、`verify --phase pre` → implementer が実装 → `verify --phase post` → 観点別の reviewer によるレビュー（最大2ラウンド）→ 1タスク1コミット
7. 全タスクが終わったら `verify --phase pr` を通し、PR を作る。ワークツリーは残したまま抜ける
8. PR がマージかクローズされたら `/tasque-loop:clean` で片付ける。`.tasque/`（git に無視されている）を元のチェックアウトの `.tasque/archive/<ワークツリー名>/` に退避してから、ワークツリーとブランチを消す（`scripts/worktrees.mjs`）

## 記録

ランの実行中に、次のスクリプトが `.tasque/runs/<run>/` に記録を残します。最後に `ledger.mjs` がそれらを1件にまとめて、ローカル台帳（`TASQUE_LEDGER_DIR`、なければ `~/.tasque/ledger`。remote のない独立した git リポジトリ）にコミットします。

- `review-feedback.mjs --verdict changes_requested|approved --text-file <パス>`: 契約の下書きへの人間のレビュー（原文）
- `escalate.mjs` / `answer.mjs --answer-file <パス>`: implementer のエスカレーションと人間の回答
- `record-review.mjs --run <run> --task <id> --round <1|2> --findings-file <パス>`: reviewer の指摘とその扱い
- `verify --phase post`: post の試行履歴（`tasks/<id>.post-history.json`）
- `ledger.mjs --run <run>`: 台帳への記録

人間や LLM の文章は、シェルで展開されないようにファイルで渡します。

## verify のフェーズ

| フェーズ | いつ | 何を確かめるか |
| --- | --- | --- |
| `baseline` | worktree 作成直後、planner より前 | HEAD・ブランチ・日時と、`test_cmd` の結果を `.tasque/baseline.json` に記録する。全体テストが落ちれば exit 1（ランを始めない） |
| `red` | 承認前 | 下書きの受け入れコマンドを実行する。通常の失敗（✖ Red）だけが期待どおりで、実装前から通った・コマンドが壊れている・タイムアウトは warning として表示する |
| `pre` | 各タスクの実装前 | 作業ツリーがクリーン、テストがコミット済み、ベースブランチの上にいないこと。通ればタスクの基点を記録する（同じタスクにはもう使えない） |
| `post` | 各タスクの実装後 | 変更が `allow` に収まり、どのタスクのテストも変わっておらず、`max_diff` を超えず、受け入れコマンドが通ること。変更の一覧は受け入れコマンドの実行後のもので判定する |
| `pr` | 全タスクの後 | 承認時の基点コミットからの変更がどれかのタスクに属し、テストが承認時のまま（sha256）で、PR の上限を超えず、`test_cmd` と全タスクの受け入れコマンドが通ること |

承認（`approve.mjs`）は次を満たさないと拒否します。

- 下書きの検査が ok で、検査時・Red 確認時・現在の契約とテストのハッシュが一致する（`decision` はハッシュに含めない）
- `.tasque/baseline.json` があり、基点の全体テストが通っている
- 現在のブランチが契約の `base` ではなく、HEAD が detached でない

コマンドの結果は `pass`・`fail`・`broken`（コマンドが見つからない、起動できない、出力が多すぎる、想定外のシグナル）・`timeout` に分類します。タイムアウト時はプロセスツリーごと止めます。

## 設定（tasque.config.json）

プロジェクトルート（`.tasque/` を置くディレクトリ）に置きます。すべて任意です。

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `test_cmd` | `null` | プロジェクト全体のテスト。文字列か `{ "cmd": "...", "cwd": "packages/app" }`。`baseline` と `pr` で走らせる |
| `diff_exclude` | `[]` | diff 量の計算から外すパスの glob（lockfile、生成物など）。スコープの照合からは外さない |
| `command_timeout_sec` | `600` | コマンド1本あたりのタイムアウト |
| `pr` | `{ "max_lines": 500, "max_files": 10 }` | `pr` フェーズのサイズ上限 |

契約の受け入れコマンドには `cwd`（プロジェクトルートからの相対パス）を指定できます。

`tasque.config.json` は必ずコミットしてください。git に無視されていると新しい worktree に入らず既定値で動いてしまうため、`baseline`・`red`・`pre` で warning を出します。

## モノレポ

プロジェクトはリポジトリのサブディレクトリでも構いません。検査は git の出力をリポジトリ全体で受け取り、プロジェクトからの相対パスに直して照合します。プロジェクトの外の変更はスコープ違反になります。

Claude Code は worktree に入っても `CLAUDE_PROJECT_DIR` を元のリポジトリのまま渡すため、フックと CLI は作業場所（cwd）側の worktree をプロジェクトとして扱います。`CLAUDE_PROJECT_DIR` がリポジトリのサブディレクトリなら、同じオフセットを worktree 側にも適用します。

## 注意

- `red`・`post`・`pr` は planner や implementer が書いたコードを実行します。Claude Code のサンドボックス（macOS・Linux・WSL2）を有効にして使うことを勧めます。ネイティブの Windows にはサンドボックスがなく、特に `red` は人間の承認前、つまりレビュー前のコードを実行します
- スキルを使わずに手で回す場合も、テストのコミットは `git add -A` ではなく、契約の `tests` に挙げたパスを明示して行ってください（意図しないファイルまで基点に入るのを防ぐため）
