# workgym

LLM に実装を任せつつ、最終レビューは人間が持つための Claude Code の仕組みと、その仕組み自体を失敗から改良し続けるための仕組みを置くリポジトリです。

人間のレビューを計画の段階に前倒しし、機械で確かめられることはスクリプトとフックで強制し、人間が見る対象を判断と不確実な点に絞ります。

## 構成

| サブシステム | 役割 | 状態 |
| --- | --- | --- |
| [tasque-loop](plugins/tasque-loop/) | 機能要件をタスク契約と受け入れテストに分け、人間の承認後に1タスクずつ実装・検査・レビューして PR にする Claude Code プラグイン。実行の記録をローカル台帳に残す | 基礎機能まで |
| ledger-sync | ローカル台帳から汎用的な一般則だけを取り出し、人間の承認を通してリモート台帳に送る | 未着手 |
| kaizen-kaigi | リモート台帳を読み、tasque-loop への改良を PR として提案する | 未着手 |

全体の構想は [docs/overview.md](docs/overview.md)、tasque-loop の仕様は [docs/tasque-loop.md](docs/tasque-loop.md)、残っている作業は [docs/backlog.md](docs/backlog.md) にあります。

## tasque-loop を入れる

Claude Code で次を実行します。

```
/plugin install tasque-loop --marketplace ebiselutica/workgym
```

入れたら、対象のリポジトリで `/tasque-loop:run <要件>` を実行します。使い方の詳細は [plugins/tasque-loop/README.md](plugins/tasque-loop/README.md) を参照してください。

## 必要なもの

- Claude Code（最新版を前提にしています）
- Node.js 24
- git 2.31 以上

## 情報の扱い

このリポジトリには仕組みのコードと文書だけを置きます。実行の記録（ローカル台帳）は各マシンのリポジトリの外に置き、マシンの外には出しません。外に出すのは汎用的な一般則だけで、その判断は ledger-sync と人間の承認が担います。詳しくは [docs/overview.md](docs/overview.md) の「情報の扱い」を参照してください。

## 開発

```
cd plugins/tasque-loop
node --test
```

GitHub Actions で ubuntu・windows・macos のテストを回します。

## ライセンス

[MIT](LICENSE)
