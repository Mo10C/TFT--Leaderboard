/* =============================================================
   マウンテンチョンク校 TFT リーダーボード - 設定ファイル
   ここだけ書き換えればOK。index.html / editor.html の両方が参照します。
   ============================================================= */

window.TFT_CONFIG = {

  /* ---- 1. Firebase（全員でリアルタイム共有するために必須）----
     Firebase コンソール → プロジェクト設定 → 「ウェブアプリ」の
     firebaseConfig をまるごとここに貼り付けてください。
     空のままだと「ローカル保存モード（自分のブラウザ内のみ）」で動きます。 */
  firebase: {
    apiKey:            "",
    authDomain:        "",
    projectId:         "",
    storageBucket:     "",
    messagingSenderId: "",
    appId:             ""
  },

  /* ---- 2. Cloudflare Worker（Riot API の中継先）----
     worker.js をデプロイした後に出る URL を貼り付け。
     例: "https://tft-riot-proxy.あなたのサブドメイン.workers.dev"
     空のままだと結果は手入力のみになります（自動取得は無効）。 */
  workerUrl: "",

  /* ---- 3. Riot リージョン ----
     日本サーバーなら下記のままでOK。
     region は account / match API のルーティング (asia / americas / europe)。 */
  region: "asia",

  /* ---- 4. ボードの初期値（任意・あとから画面でも変更可）---- */
  defaults: {
    matchCount: 3,   // 試合数
    tableCount: 2,   // 卓数
    mode: "solo"     // "solo"=個人戦 / "team"=チーム戦(4v4) / "doubleup"=ダブルアップ
  }
};
