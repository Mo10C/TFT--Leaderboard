# マウンテンチョンク校 TFT リーダーボード

全員で同じボードをリアルタイム共有しながら、ドラッグで組卓 → 順位を Riot API 自動取得 →
卓別・全体の順位表を表示する大会用リーダーボードです。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 本番ボード（全員で操作・閲覧。組卓・結果） |
| `editor.html` | 管理コンソール（選手マスタ・順位手入力・API設定・バックアップ） |
| `tft-core.js` | 共通ロジック（得点計算・同期・API） |
| `config.js` | **設定ファイル（ここだけ書き換える）** |
| `worker.js` | Cloudflare Worker（Riot API 中継） |
| `assets/` | もと先生アバター（`moto-hero.png` `moto-focus.png` `moto-rage.png`） |

デザインは「マウンテンチョンク校 TOOLS」ポータルと統一（ライト基調＋ダーク切替、pink→cyanグラデ、六角モチーフ、Space Grotesk + Zen Kaku Gothic New）。テーマ設定はポータルと同じ `mcc-portal-theme` を共有します。

---

## ざっくり全体像

```
ブラウザ(index/editor)  ──書込/購読──▶  Firebase Firestore  ◀──同じボードを全員が共有
        │
        └──結果取得──▶  Cloudflare Worker  ──▶  Riot API（キーはWorker内で秘匿）
```

GitHub Pages は静的ファイルしか置けないため、
**共有（Firestore）** と **Riot API（Worker）** は外部サービスを使います。どちらも無料枠で足ります。

---

## セットアップ

### 1. GitHub Pages（ファイル置き場）

1. リポジトリに 5ファイル（`index.html` `editor.html` `tft-core.js` `config.js` `worker.js`）をプッシュ
   ※ `worker.js` は Pages では使わないが置いておいてOK
2. リポジトリ Settings → Pages → Branch を `main` / `root` で公開
3. `https://ユーザー名.github.io/リポジトリ名/index.html` で開ける

> この時点で **Firebase/Worker 未設定でも「ローカル保存モード」で単独動作**します（自分のブラウザ内のみ）。まず動作確認したい時に便利。

### 2. Firebase Firestore（全員でリアルタイム共有）

1. [console.firebase.google.com](https://console.firebase.google.com) でプロジェクト作成
2. 「Firestore Database」を作成（**本番モード**でも**テストモード**でも可。下のルール参照）
3. プロジェクト設定 → アプリを追加（**ウェブ</> アイコン**）→ 表示される `firebaseConfig` を
   `config.js` の `firebase` にコピー
4. Firestore のルール（テスト用。誰でも読み書き可）:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /boards/{boardId} {
         allow read, write: if true;
       }
     }
   }
   ```
   > 大会中だけ公開、終わったら閉じる運用が安全。心配なら有効期限付きルールやAuthも検討。

これで `config.js` に正しい設定が入っていれば、ヘッダーのバッジが **● LIVE 共有中** になります。

### 3. Cloudflare Worker（Riot API 自動取得）※任意

順位を手入力だけにするなら飛ばしてOK。

1. [Riot Developer Portal](https://developer.riotgames.com/) でAPIキーを取得
   （個人用Development Keyは24時間で失効。大会の都度更新 or Production申請）
2. Cloudflare で Worker を作成し `worker.js` の内容をデプロイ
   - ダッシュボードで新規Worker → コードを貼り付け → Deploy
   - もしくは `wrangler` でデプロイ
3. Worker のシークレットに APIキーを登録:
   - ダッシュボード: Worker → Settings → Variables and Secrets → `RIOT_API_KEY` を **Secret** で追加
   - CLI: `npx wrangler secret put RIOT_API_KEY`
4. 発行された URL（例 `https://tft-riot-proxy.xxx.workers.dev`）を `config.js` の `workerUrl` に貼る
5. `editor.html` の「Riot API → 接続テスト」で確認

---

## 使い方

### 本番ボード `index.html`（全員で操作）
1. 上部タブでモード選択（個人戦／チーム戦4v4／ダブルアップ）
2. 試合数・卓数を設定
3. 名前を入力して「追加」→ 選手POPが出る
4. POPをタップ → 席をタップで配置（PCはドラッグも可）。第N試合タブで試合切替
5. 「結果」タブ → 「全卓を自動取得」で Riot API から順位反映、または各順位を直接入力
6. 結果は **全体順位** ＋ **各試合の卓別順位** が表として並ぶ
7. 「共有リンク」を配れば全員が同じボードを操作・閲覧

### 管理コンソール `editor.html`（主催者向け）
- 選手マスタに名前＋Riot IDを事前登録（一括追加も可）
- 順位の手入力／修正
- 接続テスト・全卓一括取得
- JSONバックアップ／復元
- ボードID切替（大会ごとに別ボード）・全結果クリア・初期化

---

## ポータル（マウンテンチョンク校 TOOLS）への組み込み

このリーダーボードは単体でも動きますが、ポータルの1ツールとして並べるのがおすすめです。

1. リポジトリ直下に `leaderboard/` フォルダを作り、この一式（`index.html` 等＋`assets/`）を入れる
2. ポータルの **editor.html**（「マウンテンチョンク校 TOOLS」の編集ページ）でツールを追加
   - タイトル: `TFT リーダーボード` / アイコン: 🏆 / URL: `leaderboard/index.html` / カテゴリ: コーチング など
3. 「💾 data.json をダウンロード」→ コミット。ポータルのタイルから開けるようになります

> サイトの全変更は editor.html で管理する方針なので、公開ツールとして追加するのもポータルの editor.html 経由でOKです。
> なお、このリーダーボードの **Worker（Riot中継）** はポータルの認可Worker（Discordロール）とは別物です。両方デプロイして共存できます。

## 画像パスについて

各HTMLは同じ階層の `assets/moto-*.png` を参照します（`leaderboard/assets/...`）。
別の場所に画像を置く場合は `index.html`/`editor.html` の `src="assets/..."` を書き換えてください。画像が無くてもレイアウトは崩れません（自動で非表示）。



URL に `?board=任意のID` を付けると別ボードになります。
- 例: `index.html?board=gasshuku-2026`
- 管理コンソールの「ボードID切替」からも開けます
- `?board=` 無しは `default` ボード

---

## 得点ルール（確定仕様）

| モード | 集計 |
|---|---|
| 個人戦 | 1位8pt 〜 8位1pt。全体は個人累計ptで順位 |
| チーム戦 4v4 | 8人卓を4人×2チーム。各員の獲得pt(8〜1)合計が多いチームの勝ち |
| ダブルアップ | 4ペア。1位8・2位6・3位4・4位2pt（ペア両者に付与） |

> Riot API のダブルアップ判定では placement(1〜8) をペア順位(1〜4)に自動変換します。
> 形式が想定と違う場合は管理コンソールの手入力で上書きしてください。

---

## 注意点

- **自動取得の条件**: 卓の登録選手のうち Riot ID 登録済みが2人以上必要。
  「卓の全員を含む直近マッチ」を履歴から探して反映します（カスタム/ランク両対応）。
- **APIキーの寿命**: Development Key は24時間。大会前に更新を。
- **同時編集**: 後勝ち（最後の書き込みが優先）。複数人が同じ席を同時に動かすと競合し得ます。
- **無料枠**: Firestore・Worker とも通常の大会規模なら無料枠内。
