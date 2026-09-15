# 料金定期取得（GitHub Actions）

毎日 9:00 JST に楽天空室APIを叩き、`data/latest.json` を更新する。

## 初回セットアップ

1. リポジトリ Settings → Secrets and variables → Actions に以下を追加
   - `RAKUTEN_APPLICATION_ID`
   - `RAKUTEN_ACCESS_KEY`  
   （値は公開ページのAPI設定、または既存 `index.html` のデフォルトと同じものを使える）
2. Actions タブで `price-check` を許可（初回は workflow 追加後）
3. 「Run workflow」で手動実行して動作確認

## 手動実行の入力

| 入力 | 説明 |
|------|------|
| checkin | YYYY-MM-DD。空なら明日（JST） |
| checkout | YYYY-MM-DD。空なら checkin + nights |
| nights | checkout未指定時の泊数（既定1） |
| zone | `all` / `30` / `50` |

## 成果物

- `data/latest.json` … 最新料金（コミット＆Artifact）
- `data/hotels.json` … 宿マスター（HTMLから抽出）

## カレンダー連携（次）

カレンダーに「宿を取る」予定が付いたら、その日付で `workflow_dispatch` するか、`data/watch.json` に日付を書いてこの workflow が読む想定。

## 宿マスター・クリーニング

`scripts/health-check.mjs` が複数サンプル日で空室・料金を見て、`data/cleanup-candidates.json` / `.md` を出す。

判定:
- **削除候補**: 施設名不一致・APIエラー
- **要確認**: サンプル全日で空室なし / 1泊3万円以上 / 中央値×3超
