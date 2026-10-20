# 人狼ゲーム (Astro + Cloudflare Workers/Durable Objects)

## 構成
- `site/` … Astro製のフロントエンド（GM画面・参加者画面）。GitHub連携でCloudflare Pagesに自動デプロイする想定。
- `worker/` … Cloudflare Workers + Durable Objectsで動くリアルタイムバックエンド。部屋ごとに1つのDurable Objectが
  参加者・役職・フェーズ・投票を管理し、WebSocketで全員にブロードキャストします。役職は各プレイヤーの接続に
  対してのみ個別送信されるので、他プレイヤーには見えません。

## セットアップ手順

### 1. Workerをデプロイする（先にこちらを公開）
```bash
cd worker
npm install
npx wrangler login        # 初回のみ、Cloudflareアカウント連携
npm run deploy             # デプロイ完了後にWorkerのURLが表示されます
```
表示されたURL（例: `https://jinro-realtime.your-subdomain.workers.dev`）を控えておいてください。

### 2. Astroサイト側にWorkerのURLを設定する
`site/.env.example` を `site/.env` にコピーし、`PUBLIC_WORKER_URL` を手順1で得たURLに書き換えます。

```bash
cd site
cp .env.example .env
npm install
npm run dev   # ローカル確認（http://localhost:4321）
```

### 3. GitHub + Cloudflare Pages で公開する
1. このリポジトリ（`site/` を含む）をGitHubにpushします。
2. Cloudflare Dashboard → Workers & Pages → Pages → 「Gitに接続」で対象リポジトリを選択。
3. ビルド設定:
   - フレームワークプリセット: Astro
   - ビルドコマンド: `npm run build`
   - ビルド出力ディレクトリ: `dist`
   - ルートディレクトリ: `site`
4. 環境変数に `PUBLIC_WORKER_URL`（手順1のWorker URL）を追加してデプロイ。

以降はGitHubにpushするたびに自動で再デプロイされます。

## 遊び方
1. GMが `/gm` を開き「部屋を作成する」→ 5文字のルームコードが発行されます。
2. 参加者は `/join` からニックネームとルームコードを入力して参加（各自のスマホ/PCからOK）。
3. GMは役職ごとの人数を設定し「ゲーム開始」を押すと、サーバー側でシャッフルして各自に役職が個別配信されます。
4. GMが「次のフェーズへ進める」を押すたびに 夜→昼→投票→結果 と進行し、投票フェーズでは参加者が画面から投票できます。
5. 人狼が全滅、または人狼の数が他陣営以上になった時点で勝敗が自動判定されます。

## カスタマイズのヒント
- 役職や勝利条件のロジックは `worker/src/GameRoom.ts` にまとまっています。役職を増やす場合は
  `ROLE_LABELS` と各画面の `ROLE_LABELS`（`site/src/pages/*.astro`）に追記してください。
- GMトークン・部屋コードはDurable Objectのメモリ上にのみ保持されます（サーバー再起動等でリセットされる場合があります）。
  長期運用する場合は `GameRoom` に `this.state.storage` を使った永続化を追加してください。
