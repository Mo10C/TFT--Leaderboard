/* =============================================================
   TFT リーダーボード（ログイン式・大会だけの版）— 設定ファイル

   ポータル版とは別フォルダに置いて使います。
   Firebase と Worker は同じものを使い回しますが、
   ★ collections で保存先を分けているので、データは混ざりません。

   ⚠️ このファイルは「あなた専用の設定」です。
      更新時に上書きしないよう気をつけてください。
   ============================================================= */

window.MCC_LB_CONFIG = {

  /* ---- 1. 保存先のコレクション（★この版でいちばん大事）----
     ポータル版は lboards / lboard_index を使っています。
     ここを変えてあるので、同じ Firebase プロジェクトを使っても
     大会データが混ざりません。

     ※ 変更したら、Firestore のルールにも同じ名前を足してください（README参照）。
     ※ prefix は「Firebaseを使わずローカル保存で動かすとき」の
       localStorage のキー名です。こちらも分けてあります。 */
  collections: {
    boards: "tboards",        // 大会ボード本体
    index:  "tboard_index",   // 大会の索引（一覧用）
    prefix: "mcccup"          // ローカル保存モードのキー名
  },

  /* ---- 2. Firebase（全員でリアルタイム共有するために必須）----
     ポータル版と同じプロジェクトでOKです（上の collections で分けているため）。 */
  firebase: {
    apiKey: "AIzaSyCyZ7IbKh02V8fvILTCDTgLPKRuoNFS78Y",
    authDomain: "tft-leaderboard-f6897.firebaseapp.com",
    projectId: "tft-leaderboard-f6897",
    storageBucket: "tft-leaderboard-f6897.firebasestorage.app",
    messagingSenderId: "931359784793",
    appId: "1:931359784793:web:d7c2bf264d517974a9d648",
    measurementId: "G-T14B3XQY8R"
  },

  /* ---- 3. Cloudflare Worker（Riot API 中継 ＋ Discord OAuth）----
     いま動いているものをそのまま使います。末尾のスラッシュは付けない。

     ★ Discord Developer Portal の Redirects に、
       このフォルダの login.html のURLを足してください（README参照）。 */
  workerUrl: "https://tft-riot-proxy.moto-moto-tennis.workers.dev",

  /* ---- 4. Riot ルーティング ---- */
  region: "asia",
  platform: "jp1",

  /* ---- 5. Discord（表示用・任意）---- */
  discord: {
    guildName: "",          // 例: "〇〇コミュニティ"（未参加の人への案内に出ます）
    inviteUrl: ""              // 例: "https://discord.gg/xxxx"（空なら非表示）
  },

  /* ---- 6. 大会の初期値 ---- */
  defaults: {
    matchCount: 3,   // 試合数
    tableCount: 2    // 卓数
  },

  /* ---- 7. ★★ 管理者 ----
     ここに載っている人だけが
       ・大会名 / 試合数 / 卓数 / 公開範囲の変更
       ・組卓・席の配置・順位の入力・自動取得
       ・admin.html（管理画面）全体
     を操作できます。ほかの人は「閲覧 ＋ 自分の出欠チェック」のみ。

     ⚠️ 3つとも空だと「セットアップ中」とみなして全員が管理者になります。 */
  admins: {
    usernames: ["mo10c","sensuishi_no13"],        // Discordのユーザー名（@は付けても付けなくてもOK）
    discordIds: [],              // DiscordのユーザーID（最も確実・推奨）
    riotIds: []                  // 空のままを推奨（誰でも打てる文字列のため）
  },

  /* ---- 8. ロール設定（任意）----
     staffRoleIds: このロールの人は「見るだけの人」になり、
                   参加者・組卓・全体順位に入りません。
                   大会に出てもらうときは管理画面の「👥 メンバー」でONにします。 */
  roles: {
    pinnedOrder: [],
    adminRoleIds: [],
    staffRoleIds: []
  }
};
