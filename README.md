# Soki Editor

構造化された長文ドキュメントをLLMで支援する執筆アプリケーション。

学術論文・記事・報告書などの長文を、章・節・小節のアウトライン構造で管理しながら、LLMによる生成・修正・レビューをチャット形式で行えます。

## 機能

- **文書構造管理** — 章・節・小節の階層アウトラインを管理し、各セクションに概要（LLMコンテキスト）と本文を保持
- **LLMチャット生成** — セクションごとにLLMへ生成・修正を指示。送信コンテキスト範囲（全体/特定セクション）とソース参照深度（要約/全文）を制御可能
- **ソース・文献管理** — .txt / .md / .pdf / .csv をアップロードしてLLMのコンテキストとして参照。エクスポート時に参考文献番号を自動変換
- **マテリアル管理** — 画像ファイルをプロジェクトに紐付け、本文に挿入。エクスポート時に図番号を自動変換
- **ルールベース執筆** — 表現ガイドラインをルールとして登録し、すべてのLLM呼び出しに自動付加して文体を統一
- **文書レビュー** — LLMが全セクションを総合的にレビューし、セクションごとに改善コメントを提示

## 技術スタック

| レイヤー | 使用技術 |
|----------|----------|
| バックエンド | FastAPI + Uvicorn |
| デスクトップUI | pywebview |
| LLM連携 | OpenAI互換API（OpenAI / Azure OpenAI / Ollama等） |
| RAG | LangChain + Chroma |
| ファイル解析 | MarkItDown / PyMuPDF / Pillow |
| データ保存 | ローカルJSONファイル |

## 動作環境

- Python 3.11 以上

## インストール

```bash
git clone https://github.com/your-org/Soki-Editor.git
cd Soki-Editor

python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

pip install -e .
```

## 起動

```bash
python main.py
```

アプリケーションウィンドウが開きます。`pywebview` がインストールされていない場合はブラウザで `http://127.0.0.1:808x/` にアクセスしてください（コンソールに表示されるURLを確認）。

## 開発環境のセットアップ

```bash
pip install -e ".[dev]"
pytest
```

## データ構造

プロジェクトデータはローカルに保存されます。

```
{任意のディレクトリ}/
├── {projectID}.json          # プロジェクト全データ（自動保存）
└── {projectID}/data/
    ├── sources/               # ソースファイル実体
    └── materials/             # 図表ファイル実体
```

## 本文中の参照記法

```
文献引用:  [^ref-001]                    → エクスポート時 [1]
図表挿入:  ![キャプション](path "fig-001") → エクスポート時 図1 キャプション
```

## LLM設定

APIキー・エンドポイントURL・モデル名はプロジェクトごとに設定します。OpenAI互換APIであればローカルLLM（Ollama等）も利用できます。

## ライセンス

[LICENSE](LICENSE) を参照してください。
