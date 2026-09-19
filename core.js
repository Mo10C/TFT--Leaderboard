/* =============================================================
   core.js — ログイン式リーダーボード 共通コアロジック
   セッション / 権限 / データ模型 / 得点計算 / Firestore同期 / Riot API / ロール

   login.html / index.html / editor.html が読み込みます。

   ★ 選手（roster の1件）はログインしたユーザーそのもの:
     { id: "u_<discordId>",
       name, nameLocked, riotId, puuid,
       rank: { tier, division, lp, queue },
       discord: { id, name, username, avatar, kind:"teacher"|"student" },
       roles: [{id, name, color}],   // ★ 先生 / 生徒 だけ。Discordのギルドロールは使いません。
       kindLocked,                   // 管理者が立場を変えた印（再ログインで戻らない）
       joinedAt, updatedAt }

   ★ ボード状態（v2互換の縮小版・個人戦）:
     { mode:"solo", title, matchCount, tableCount,
       roster:[player], matches:[{ tables:[{seats[8], placements{}}], present }],
       updatedAt }
     present: pid配列（null=全員参加）

   ★ 権限（v2.1 で追加）:
     store.setActor({ pid, isAdmin }) を呼んでから使う。
     - 管理者          : すべての操作
     - 一般プレイヤー  : 閲覧 ＋ 自己登録（upsertSelf）＋ 自分の出欠のみ
     ガードに弾かれると window に "lb-denied" イベントが飛びます。
   ============================================================= */
(function () {
  "use strict";

  const CFG = window.MCC_LB_CONFIG || {};
  /* ★ 保存先のコレクション名。config.js の collections で変えられる。
     ここを分けておけば、ポータル版（lboards）と大会版のデータが混ざらない。 */
  const COL  = String((CFG.collections || {}).boards || "lboards");
  const ICOL = String((CFG.collections || {}).index  || "lboard_index");
  const LSP  = String((CFG.collections || {}).prefix || "mcclb2");
  const SEATS_PER_TABLE = 8;
  /* ★ ダブルアップ（2人1組）。1卓は 2人×4チーム。
     卓の「席」には、ソロなら選手ID、ダブルアップならチームIDが入ります。
     この「席に入るもの」をコードの中では unit（ユニット）と呼んでいます。 */
  const TEAMS_PER_TABLE = 4;
  const TEAM_SIZE = 2;
  function isDouble(x) {
    const m = (x && typeof x === "object") ? x.mode : x;
    return m === "doubleup";
  }
  // その卓にいくつスロットがあるか（ソロ8／ダブルアップ4）
  function slotCount(x) { return isDouble(x) ? TEAMS_PER_TABLE : SEATS_PER_TABLE; }

  /* =============================================================
     接続設定（config.js を localStorage で上書きできる）
     ============================================================= */
  /* ★ localStorage のキーは collections.prefix（= mcccup）から作ります。
     ポータル版は mcclb2 なので、同じブラウザで両方を開いても
     ログイン情報が上書きし合いません。 */
  const RIOT_CFG_KEY = LSP + "-riot-config";
  function readOverride() {
    try { const raw = localStorage.getItem(RIOT_CFG_KEY); return raw ? (JSON.parse(raw) || {}) : {}; }
    catch (e) { return {}; }
  }
  function effCfg() {
    const o = readOverride();
    const v = (k, d) => (o[k] != null && o[k] !== "") ? String(o[k]).trim() : (CFG[k] || d);
    return { workerUrl: v("workerUrl", ""), region: v("region", "asia"), platform: v("platform", "jp1") };
  }
  const RiotConfig = {
    effective() { return effCfg(); },
    base() { return { workerUrl: CFG.workerUrl || "", region: CFG.region || "asia", platform: CFG.platform || "jp1" }; },
    override() { return readOverride(); },
    isOverridden() {
      const o = readOverride(), b = this.base();
      return !!((o.workerUrl && o.workerUrl !== b.workerUrl) || (o.region && o.region !== b.region) || (o.platform && o.platform !== b.platform));
    },
    set(patch) {
      const o = readOverride();
      ["workerUrl", "region", "platform"].forEach(k => { if (patch && (k in patch)) o[k] = (patch[k] || "").trim(); });
      try { localStorage.setItem(RIOT_CFG_KEY, JSON.stringify(o)); } catch (e) { }
      return effCfg();
    },
    clear() { try { localStorage.removeItem(RIOT_CFG_KEY); } catch (e) { } return effCfg(); }
  };

  /* =============================================================
     ★ 立場（先生 / 生徒）
     この版は Discord サーバーのロールを一切見ません。
     Discordからは「表示名」と「アイコン」だけを受け取り、
     ログイン時に本人が選んだ 先生 / 生徒 をロールの代わりに使います。
     ロールの仕組み（絞り込み・自動組卓・公開範囲）はそのまま流用できるよう、
     選んだ立場を roles:[{id,name,color}] の形に変換して持たせています。
     ============================================================= */
  const KIND_ROLES = [
    { id: "teacher", name: "先生", color: 0xEFA317 },
    { id: "student", name: "生徒", color: 0x2E9BC9 }
  ];
  function kindRole(kind) {
    const k = String(kind || "");
    const r = KIND_ROLES.find(x => x.id === k);
    return r ? Object.assign({}, r) : null;
  }
  function kindLabel(kind) { const r = kindRole(kind); return r ? r.name : "—"; }
  // player / session / discord のどれを渡してもよい
  function kindOf(x) {
    if (!x) return "";
    const d = x.discord || x;
    if (d && kindRole(d.kind)) return String(d.kind);
    const roles = (Array.isArray(x.roles) && x.roles) ||
                  (Array.isArray(d.roles) && d.roles) || [];
    const hit = roles.find(r => r && kindRole(r.id));
    return hit ? String(hit.id) : "";
  }
  // 立場を roles 配列にする（該当なしなら空配列）
  function kindRolesOf(x) { const r = kindRole(kindOf(x)); return r ? [r] : []; }

  // ロール配列だけで運営かどうかを判定（Session.toPlayer から使う）
  function isStaffRoles(roles) {
    const ids = (((CFG.roles || {}).staffRoleIds) || []).map(x => String(x).trim()).filter(Boolean);
    if (!ids.length) return false;
    return (roles || []).some(r => r && ids.includes(String(r.id)));
  }

  /* =============================================================
     ★ グループ（合言葉）
     参加者を物理的に分けるしくみ。

     ・合言葉そのものはどこにも保存しません。
       SHA-256 でハッシュにして、その先頭16桁を「グループキー」にします。
     ・Firestore のボード文書IDに <グループキー>__ を付けるので、
       別の合言葉のグループとはデータが一切混ざりません。
     ・大会の索引も、グループごとに別の文書（g_<キー>）に分かれます。
     ・参加者に配るURLには ?g=<グループキー> を付けます。
       ハッシュなので、URLを見ても合言葉そのものは分かりません。
     ============================================================= */
  const GROUP_LS_KEY = LSP + "-groups";     // Firebaseを使わないときのグループ台帳

  // 合言葉のゆらぎを吸収（前後の空白・全角半角・大文字小文字）
  function normPass(pw) {
    let t = String(pw == null ? "" : pw);
    try { t = t.normalize("NFKC"); } catch (e) { }
    return t.trim().replace(/\s+/g, " ").toLowerCase();
  }
  // 合言葉 → グループキー（16桁の英数字）
  async function hashGroup(pw) {
    const t = normPass(pw);
    if (!t) throw new Error("合言葉を入力してください");
    if (!(window.crypto && window.crypto.subtle)) {
      throw new Error("この環境では合言葉を使えません（https で開いてください）");
    }
    const buf = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode("mcccup/g/" + t));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }
  function isGroupKey(k) { return /^[0-9a-f]{16}$/.test(String(k || "")); }

  function localGroups() {
    try { return JSON.parse(localStorage.getItem(GROUP_LS_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  /* Firestore のエラーを日本語にする。
     いちばん多いのが「ルールに tboards / tboard_index を足していない」なので、
     その場合は何をすればいいかを本文に書く。 */
  function fsErr(e, what) {
    const code = String((e && (e.code || e.message)) || "");
    if (/permission|insufficient|PERMISSION_DENIED/i.test(code)) {
      return new Error(
        "Firestore に拒否されました（" + COL + " / " + ICOL + " の権限がありません）。\n" +
        "Firebase コンソール → Firestore Database → ルール に、次の2行を足して「公開」してください:\n" +
        "  match /" + COL + "/{id}  { allow read, write: if true; }\n" +
        "  match /" + ICOL + "/{id} { allow read, write: if true; }"
      );
    }
    if (/unavailable|network|offline/i.test(code)) {
      return new Error("Firestore につながりませんでした。通信を確認してもう一度おためしください。");
    }
    return new Error((what ? what + "：" : "") + (code || "不明なエラー"));
  }

  const Groups = {
    normPass, hash: hashGroup, isKey: isGroupKey,
    // そのグループが既にあるか → { exists, name, createdAt }
    async get(gk) {
      if (!isGroupKey(gk)) throw new Error("グループキーの形が正しくありません");
      const db = openDb();
      if (db) {
        let snap;
        try { snap = await db.collection(ICOL).doc("g_" + gk).get(); }
        catch (e) { throw fsErr(e, "グループを読めませんでした"); }
        if (!snap.exists) return { exists: false, name: "", createdAt: 0, ownerId: "" };
        const d = snap.data() || {};
        return { exists: true, name: d.name || "", createdAt: d.createdAt || 0, ownerId: d.ownerId || "" };
      }
      const g = localGroups()[gk];
      return g ? { exists: true, name: g.name || "", createdAt: g.createdAt || 0, ownerId: g.ownerId || "" }
               : { exists: false, name: "", createdAt: 0, ownerId: "" };
    },
    /* そのグループの主催をまだ誰も名乗っていなければ、この人を主催にする。
       → 戻り値 true = あなたがこのグループの主催
       （グループを作った人が、そのまま最初の入場で主催になります） */
    async claimOwner(gk, discordId) {
      const me = String(discordId || "");
      if (!isGroupKey(gk) || !me) return false;
      const db = openDb();
      if (db) {
        try {
          const ref = db.collection(ICOL).doc("g_" + gk);
          const snap = await ref.get();
          const cur = snap.exists ? (snap.data() || {}) : {};
          if (!cur.ownerId) { await ref.set({ ownerId: me }, { merge: true }); return true; }
          return String(cur.ownerId) === me;
        } catch (e) { throw fsErr(e, "主催を決められませんでした"); }
      }
      const all = localGroups();
      const g = all[gk] || (all[gk] = { name: "", createdAt: Date.now() });
      if (!g.ownerId) {
        g.ownerId = me;
        try { localStorage.setItem(GROUP_LS_KEY, JSON.stringify(all)); } catch (e) { }
        return true;
      }
      return String(g.ownerId) === me;
    },
    // 新しいグループを作る（合言葉は保存しない）
    async create(gk, name) {
      if (!isGroupKey(gk)) throw new Error("グループキーの形が正しくありません");
      const nm = String(name || "").trim().slice(0, 40);
      const rec = { name: nm, createdAt: Date.now() };
      const db = openDb();
      if (db) {
        try { await db.collection(ICOL).doc("g_" + gk).set(Object.assign({ boards: {} }, rec), { merge: true }); }
        catch (e) { throw fsErr(e, "グループを作れませんでした"); }
      } else {
        const all = localGroups();
        all[gk] = rec;
        try { localStorage.setItem(GROUP_LS_KEY, JSON.stringify(all)); } catch (e) { }
      }
      return rec;
    },
    // いまログイン中のグループ
    current() {
      const s = Session.get();
      const g = (s && s.group) || null;
      return (g && isGroupKey(g.key)) ? { key: g.key, name: g.name || "" } : null;
    },
    currentKey() { const g = this.current(); return g ? g.key : ""; }
  };

  /* グループで分けた保存先の名前 */
  function gkOrThrow() {
    const k = Groups.currentKey();
    if (!k) throw new Error("グループが選ばれていません（ログインし直してください）");
    return k;
  }
  function boardDocId(boardId) { return gkOrThrow() + "__" + boardId; }   // Firestore の文書ID
  function registryDocId()     { return "g_" + gkOrThrow(); }            // 大会の索引
  function lsBoardKey(boardId) { return LSP + ":" + gkOrThrow() + ":" + boardId; }
  function lsIndexKey()        { return LSP + "-index:" + gkOrThrow(); }

  /* =============================================================
     セッション（ログイン状態）
     ============================================================= */
  const SESSION_KEY = LSP + "-session";   // ★ ポータル版（mcclb2-session）とは別物
  const Session = {
    get() {
      try { const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }
      catch (e) { return null; }
    },
    set(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { } },
    clear() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { } },
    // ★ グループ（合言葉）＋ Riot ＋ Discord ＋ 立場 の4つがそろって「ログイン済み」。
    //   足りない古いセッションは login.html に戻り、足りないぶんだけ埋めれば再入場できる。
    isComplete(s) {
      s = s || this.get();
      return !!(s && s.group && isGroupKey(s.group.key) &&
                s.riot && s.riot.puuid && s.discord && s.discord.id && kindOf(s.discord));
    },
    group(s) {
      s = s || this.get();
      const g = (s && s.group) || null;
      return (g && isGroupKey(g.key)) ? { key: g.key, name: g.name || "" } : null;
    },
    // Riot と Discord だけ済んでいるか（login.html の下書き復元用）
    hasAccounts(s) {
      s = s || this.get();
      return !!(s && s.riot && s.riot.puuid && s.discord && s.discord.id);
    },
    kind(s) { s = s || this.get(); return kindOf(s && s.discord); },
    // 未ログインなら login.html へ（?board= と ?g= を引き継ぐ）
    require() {
      if (this.isComplete()) return this.get();
      const p = new URLSearchParams(location.search);
      const qs = [];
      if (p.get("board")) qs.push("board=" + encodeURIComponent(p.get("board")));
      // グループはURLの ?g= か、いま持っているセッションから引き継ぐ
      const cur = this.get();
      const gk = p.get("g") || ((cur && cur.group && cur.group.key) || "");
      if (isGroupKey(gk)) qs.push("g=" + encodeURIComponent(gk));
      location.replace("login.html" + (qs.length ? ("?" + qs.join("&")) : ""));
      return null;
    },
    // セッション → roster用プレイヤーへ変換
    toPlayer(s) {
      s = s || this.get();
      if (!this.isComplete(s)) return null;
      return {
        id: "u_" + s.discord.id,
        name: s.discord.name || s.riot.gameName,
        riotId: s.riot.gameName + "#" + s.riot.tagLine,
        puuid: s.riot.puuid,
        rank: s.riot.rank || null,
        discord: {
          id: s.discord.id, name: s.discord.name,
          username: s.discord.username, avatar: s.discord.avatar,
          kind: kindOf(s.discord)
        },
        // ★ 持ち込むのは 先生 / 生徒 だけ。古いセッションのギルドロールはここで落とす。
        roles: kindRolesOf(s.discord),
        staff: isStaffRoles(kindRolesOf(s.discord)),
        updatedAt: Date.now()
      };
    },
    riotIdOf(s) {
      s = s || this.get();
      if (!s || !s.riot) return "";
      return ((s.riot.gameName || "") + "#" + (s.riot.tagLine || ""));
    }
  };

  /* =============================================================
     権限判定
     config.js:
       admins: { discordIds: [...], riotIds: ["Mo10C#819"] }
       roles:  { adminRoleIds: [...] }
     3つとも空 = 初期セットアップ中とみなして全員管理者（警告つき）
     ============================================================= */
  function adminConfig() {
    const a = CFG.admins || {};
    return {
      discordIds: (a.discordIds || []).map(x => String(x).trim()).filter(Boolean),
      // Discordのユーザー名（@のあとの一意な名前）。大文字小文字は無視。
      usernames: (a.usernames || []).map(x => String(x).trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
      riotIds: (a.riotIds || []).map(x => String(x).trim().toLowerCase()).filter(Boolean),
      roleIds: (((CFG.roles || {}).adminRoleIds) || []).map(x => String(x).trim()).filter(Boolean)
    };
  }
  // 管理者が1人も設定されていない = 誰でも操作できてしまう状態
  function isAdminConfigured() {
    const c = adminConfig();
    return !!(c.discordIds.length || c.usernames.length || c.riotIds.length || c.roleIds.length);
  }
  function isAdmin(session) {
    const s = session || Session.get();
    if (!s) return false;
    // ★ そのグループ（合言葉）を作った人は、そのグループの主催。
    //   config.js の admins に載っていなくても管理できます。
    if (s.group && s.group.owner === true) return true;
    const c = adminConfig();
    if (!isAdminConfigured()) return true; // 未設定 = セットアップ中

    const did = s.discord && s.discord.id ? String(s.discord.id) : "";
    if (did && c.discordIds.includes(did)) return true;

    const uname = (s.discord && s.discord.username ? String(s.discord.username) : "").toLowerCase();
    if (uname && c.usernames.includes(uname)) return true;

    const riot = Session.riotIdOf(s).toLowerCase();
    if (riot && riot !== "#" && c.riotIds.includes(riot)) return true;

    if (c.roleIds.length) {
      const roles = (s.discord && s.discord.roles) || [];
      if (roles.some(r => r && c.roleIds.includes(String(r.id)))) return true;
    }
    return false;
  }

  /* =============================================================
     運営（スタッフ）ロール
     config.js: roles.staffRoleIds = ["運営ロールのID"]

     このロールを持つ人は「観戦者」として扱う:
       ・すべての画面を閲覧できる（ロックしない）
       ・大会の参加者一覧・組卓・全体順位には入らない
       ・メンバー一覧・LPランキングにも出ない
     ただし記録自体は残すので、管理者が「大会に参加させる」を押せば
     普通の参加者に切り替えられる（player.optIn = true）。
     ============================================================= */
  function staffRoleIds() {
    return (((CFG.roles || {}).staffRoleIds) || []).map(x => String(x).trim()).filter(Boolean);
  }
  function isStaff(session) {
    const ids = staffRoleIds();
    if (!ids.length) return false;
    const s = session || Session.get();
    const roles = (s && s.discord && s.discord.roles) || [];
    return roles.some(r => r && ids.includes(String(r.id)));
  }
  // 選手レコードが「大会に出る人」か。運営ロール持ちは optIn されるまで出ない。
  function isParticipant(p) {
    if (!p) return false;
    if (!p.staff) return true;
    return !!p.optIn;
  }
  function participants(state) {
    return (state.roster || []).filter(isParticipant);
  }

  /* =============================================================
     得点・状態
     ============================================================= */
  function pointsFor(mode, rank) {
    if (!rank) return 0;
    if (mode === "doubleup") return ({ 1: 8, 2: 6, 3: 4, 4: 2 })[rank] || 0;
    return Math.max(0, SEATS_PER_TABLE + 1 - rank); // 9 - rank
  }

  function emptyTable(mode) { return { seats: new Array(slotCount(mode)).fill(null), placements: {} }; }
  function buildMatches(matchCount, tableCount, mode) {
    const out = [];
    for (let m = 0; m < matchCount; m++) {
      const tables = [];
      for (let t = 0; t < tableCount; t++) tables.push(emptyTable(mode));
      out.push({ tables, present: null });
    }
    return out;
  }
  function blankState() {
    const d = CFG.defaults || {};
    const mc = d.matchCount || 3, tc = d.tableCount || 2;
    return {
      mode: "solo", title: "", matchCount: mc, tableCount: tc,
      visibility: { mode: "all", roleIds: [] },
      roster: [],
      teams: [],                                  // ★ ダブルアップのペア
      matches: buildMatches(mc, tc, "solo"), updatedAt: Date.now()
    };
  }

  /* =============================================================
     ★ チーム（ダブルアップのペア）

       state.teams = [ { id, name, members:[選手ID, 選手ID], createdAt, updatedAt } ]

     ・ポイントは人ではなく「チーム」に付きます。
       途中でペアを入れ替えても、そのチームの持ちptはチームに残ります。
     ・name が空なら2人の名前から自動で作ります（「もと先生 ＆ すいちゃん」）。
     ============================================================= */
  function newTeamId() {
    return "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function teamsOf(state) { return (state && Array.isArray(state.teams)) ? state.teams : []; }
  function teamById(state, id) { return teamsOf(state).find(t => t && t.id === id) || null; }
  function teamOfPlayer(state, pid) {
    if (!pid) return null;
    return teamsOf(state).find(t => t && (t.members || []).indexOf(pid) >= 0) || null;
  }
  function teamMembers(state, team) {
    const t = (typeof team === "string") ? teamById(state, team) : team;
    return ((t && t.members) || []).map(pid => playerById(state, pid)).filter(Boolean);
  }
  function teamLabel(state, team) {
    const t = (typeof team === "string") ? teamById(state, team) : team;
    if (!t) return "—";
    if (t.name) return t.name;
    const ms = teamMembers(state, t);
    if (!ms.length) return "（空きチーム）";
    return ms.map(p => p.name).join(" ＆ ");
  }
  // チームに入っていない参加者
  function unpairedPlayers(state) {
    const used = {};
    teamsOf(state).forEach(t => (t.members || []).forEach(pid => { used[pid] = 1; }));
    return participants(state).filter(p => !used[p.id]);
  }

  /* ---- unit（席に入るもの）----
     ソロなら選手、ダブルアップならチーム。画面はこれだけ見ればよい。 */
  function unitsOf(state) {
    return isDouble(state) ? teamsOf(state).map(t => t.id) : participants(state).map(p => p.id);
  }
  function unitName(state, id) {
    return isDouble(state) ? teamLabel(state, id) : nameOf(state, id);
  }
  // そのユニットに属する選手たち（ソロなら本人1人）
  function unitPlayers(state, id) {
    if (!isDouble(state)) { const p = playerById(state, id); return p ? [p] : []; }
    return teamMembers(state, id);
  }
  // 選手ID → その人が座るユニットID
  function unitOfPlayer(state, pid) {
    if (!isDouble(state)) return pid;
    const t = teamOfPlayer(state, pid);
    return t ? t.id : null;
  }

  /* =============================================================
     ボードの公開範囲
       { mode: "all" }                        … ログイン済みの全員
       { mode: "roles", roleIds: [...] }      … いずれかのロール保持者のみ
     管理者は常に閲覧可。roleIds が空の "roles" は "all" と同じ扱い。
     ※ 画面側の制御です。Firestoreルールは別途（DESIGN-auth.md）。
     ============================================================= */
  function normVisibility(v) {
    if (!v || typeof v !== "object") return { mode: "all", roleIds: [] };
    const ids = Array.isArray(v.roleIds) ? v.roleIds.map(String).filter(Boolean) : [];
    return { mode: v.mode === "roles" ? "roles" : "all", roleIds: ids };
  }
  function canViewBoard(visibility, session) {
    const v = normVisibility(visibility);
    if (v.mode !== "roles" || !v.roleIds.length) return true;
    if (isAdmin(session)) return true;
    const s = session || Session.get();
    const roles = (s && s.discord && s.discord.roles) || [];
    return roles.some(r => r && v.roleIds.includes(String(r.id)));
  }
  function visibilityLabel(visibility, roleCatalog) {
    const v = normVisibility(visibility);
    if (v.mode !== "roles" || !v.roleIds.length) return { open: true, names: [] };
    const map = new Map((roleCatalog || []).map(r => [String(r.id), r]));
    return { open: false, names: v.roleIds.map(id => (map.get(id) || {}).name || id) };
  }

  /* =============================================================
     Store : 状態管理 + 同期（Firestore / localStorage フォールバック）
     コレクションは lboards（既存の boards と衝突しない）
     ============================================================= */
  function makeStore() {
    let state = blankState();
    let listeners = [];
    let boardId = "default";
    let mode = "local";
    let db = null, docRef = null, indexRef = null;
    let applyingRemote = false, saveTimer = null;
    let actor = { pid: null, isAdmin: false };
    let selfSession = null;   // 自動参加させる本人のセッション（ensureSelf が使う）
    // ★ 保存先はグループ（合言葉）ごとに分かれる。
    //   init() の時点でグループキーを控えておく。こうしておけば、
    //   別タブでログアウトされても、開いているこの画面が壊れない。
    let gkey = "";
    const idxKey = id => encodeURIComponent(id);
    const lsKey = () => LSP + ":" + gkey + ":" + boardId;
    const lsIdxKey = () => LSP + "-index:" + gkey;
    const docIdOf = id => gkey + "__" + id;

    function getBoardId() {
      const p = new URLSearchParams(location.search);
      return p.get("board") || "default";
    }
    function emit() { listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }
    function onChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; }

    /* ---- 権限 ---- */
    function setActor(a) {
      actor = { pid: (a && a.pid) || null, isAdmin: !!(a && a.isAdmin) };
      return actor;
    }
    function getActor() { return { pid: actor.pid, isAdmin: actor.isAdmin }; }
    function canEdit() { return !!actor.isAdmin; }
    function deny(op) {
      console.warn("[LB] 権限がないため中止しました: " + op);
      try { window.dispatchEvent(new CustomEvent("lb-denied", { detail: { op } })); } catch (e) { }
      return false;
    }
    function guard(op) { return actor.isAdmin ? true : deny(op); }

    async function init() {
      gkey = gkOrThrow();
      boardId = getBoardId();
      const fb = CFG.firebase || {};
      const hasFb = fb.apiKey && fb.projectId && typeof window.firebase !== "undefined" && firebase.firestore;
      if (hasFb) {
        try {
          if (!firebase.apps.length) firebase.initializeApp(fb);
          db = firebase.firestore();
          docRef = db.collection(COL).doc(docIdOf(boardId));
          indexRef = db.collection(ICOL).doc("g_" + gkey);
          mode = "firestore";
          const snap = await docRef.get();
          if (!snap.exists) await docRef.set(blankState());
          // ★ 取得した内容を先に state へ入れておく。
          //   これをせずに init() を返すと、呼び出し側が upsertSelf() した直後に
          //   最初の onSnapshot が飛んできて state ごと上書きし、
          //   登録したばかりの自分が消える（参加者が0人のままになる原因だった）。
          else state = normalize(snap.data());
          docRef.onSnapshot(s => {
            if (!s.exists) return;
            applyingRemote = true;
            state = normalize(s.data());
            applyingRemote = false;
            ensureSelf();   // リモート側に自分が居なければ入れ直す
            emit();
          }, err => console.error("onSnapshot", err));
          upsertIndex();
          return { mode, boardId };
        } catch (e) { console.error("Firebase init failed, falling back to local:", e); }
      }
      mode = "local";
      const raw = localStorage.getItem(lsKey());
      state = raw ? normalize(JSON.parse(raw)) : blankState();
      window.addEventListener("storage", e => {
        if (e.key === lsKey() && e.newValue) {
          applyingRemote = true;
          state = normalize(JSON.parse(e.newValue));
          applyingRemote = false;
          ensureSelf();
          emit();
        }
      });
      emit();
      upsertIndex();
      return { mode, boardId };
    }

    /* ---- 受信データの形を整える ---- */
    function normalize(data) {
      const s = Object.assign(blankState(), data || {});
      s.mode = (s.mode === "doubleup") ? "doubleup" : "solo";   // ★ 個人戦 / ダブルアップ
      s.title = typeof s.title === "string" ? s.title : "";
      s.matchCount = Math.max(1, s.matchCount | 0 || 1);
      s.tableCount = Math.max(1, s.tableCount | 0 || 1);
      s.visibility = normVisibility(s.visibility);
      if (!Array.isArray(s.roster)) s.roster = [];
      s.roster = s.roster.filter(p => p && p.id).map(p => ({
        id: p.id, name: p.name || "—", nameLocked: !!p.nameLocked,
        staff: !!p.staff, optIn: !!p.optIn,
        riotId: p.riotId || "", puuid: p.puuid || "",
        rank: p.rank || null,
        discord: p.discord || null,
        // ★ 先生 / 生徒 だけを残す（古いデータのギルドロールはここで消える）
        roles: kindRolesOf(p),
        kindLocked: !!p.kindLocked,
        joinedAt: p.joinedAt || 0, updatedAt: p.updatedAt || 0
      }));
      /* ★ チーム（ダブルアップのペア）を整える。
         ・存在しない選手は外す
         ・同じ人が2チームに入っていたら、先に出てきたほうを残す */
      {
        const seen = {};
        const alive = id => s.roster.some(p => p.id === id);
        s.teams = (Array.isArray(s.teams) ? s.teams : [])
          .filter(t => t && t.id)
          .map(t => {
            const ms = (Array.isArray(t.members) ? t.members : [])
              .filter(pid => alive(pid) && !seen[pid])
              .slice(0, TEAM_SIZE);
            ms.forEach(pid => { seen[pid] = 1; });
            return {
              id: String(t.id), name: typeof t.name === "string" ? t.name : "",
              members: ms,
              createdAt: t.createdAt || 0, updatedAt: t.updatedAt || 0
            };
          });
      }
      const slots = slotCount(s.mode);
      // 席に入ってよいIDの集合（ソロ=選手 / ダブルアップ=チーム）
      const unitOk = isDouble(s)
        ? id => s.teams.some(t => t.id === id)
        : id => s.roster.some(p => p.id === id);
      if (!Array.isArray(s.matches)) s.matches = buildMatches(s.matchCount, s.tableCount, s.mode);
      for (let m = 0; m < s.matchCount; m++) {
        if (!s.matches[m]) s.matches[m] = { tables: [], present: null };
        if (!Array.isArray(s.matches[m].tables)) s.matches[m].tables = [];
        for (let t = 0; t < s.tableCount; t++) {
          let tb = s.matches[m].tables[t];
          if (!tb) { tb = emptyTable(s.mode); s.matches[m].tables[t] = tb; }
          if (!Array.isArray(tb.seats)) tb.seats = new Array(slots).fill(null);
          // モードを切り替えたあとなど、席の数が合わなければ入れ直す
          tb.seats = tb.seats.filter(id => id && unitOk(id));
          while (tb.seats.length < slots) tb.seats.push(null);
          tb.seats.length = slots;
          if (!tb.placements || typeof tb.placements !== "object") tb.placements = {};
          Object.keys(tb.placements).forEach(id => { if (!unitOk(id)) delete tb.placements[id]; });
        }
        const pr = s.matches[m].present;
        s.matches[m].present = Array.isArray(pr) ? pr.filter(id => unitOk(id)) : null;
      }
      s.matches.length = s.matchCount;
      return s;
    }

    /* ---- 保存（デバウンス）---- */
    function save() {
      if (applyingRemote) return;
      state.updatedAt = Date.now();
      emit();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 250);
    }
    async function persist() {
      try {
        if (mode === "firestore" && docRef) await docRef.set(JSON.parse(JSON.stringify(state)));
        else localStorage.setItem(lsKey(), JSON.stringify(state));
        upsertIndex();
      } catch (e) { console.error("persist failed", e); }
    }

    /* ---- ボード索引 ---- */
    function indexEntry() {
      return {
        title: state.title || "", matchCount: state.matchCount, tableCount: state.tableCount,
        players: participants(state).length, visibility: normVisibility(state.visibility),
        updatedAt: state.updatedAt || Date.now()
      };
    }
    async function upsertIndex() {
      try {
        if (mode === "firestore" && indexRef) await indexRef.set({ boards: { [idxKey(boardId)]: indexEntry() } }, { merge: true });
        else {
          const idx = JSON.parse(localStorage.getItem(lsIdxKey()) || "{}");
          idx[boardId] = indexEntry();
          localStorage.setItem(lsIdxKey(), JSON.stringify(idx));
        }
      } catch (e) { console.error("index upsert failed", e); }
    }
    async function listBoards() {
      let map = {};
      try {
        if (mode === "firestore" && indexRef) {
          const snap = await indexRef.get();
          if (snap.exists) Object.entries((snap.data() || {}).boards || {}).forEach(([k, v]) => { map[decodeURIComponent(k)] = v; });
        } else map = JSON.parse(localStorage.getItem(lsIdxKey()) || "{}");
      } catch (e) { console.error("listBoards", e); map = {}; }
      if (!map[boardId]) map[boardId] = indexEntry();
      return Object.entries(map).map(([id, v]) => ({
        id, title: (v && v.title) || "", matchCount: v && v.matchCount, tableCount: v && v.tableCount,
        players: (v && v.players) || 0, visibility: normVisibility(v && v.visibility),
        updatedAt: (v && v.updatedAt) || 0
      })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    function setBoardTitle(name) {
      if (!guard("大会名の変更")) return;
      state.title = (name || "").trim();
      save();
    }
    // 公開範囲の設定（管理者のみ）
    function setVisibility(patch) {
      if (!guard("公開範囲の変更")) return;
      const cur = normVisibility(state.visibility);
      const next = normVisibility({
        mode: patch && patch.mode != null ? patch.mode : cur.mode,
        roleIds: patch && patch.roleIds != null ? patch.roleIds : cur.roleIds
      });
      state.visibility = next;
      save();
    }

    /* ---- 設定 ---- */
    function setSettings(patch) {
      if (!guard("試合数・卓数の変更")) return;
      const mc = Math.max(1, (patch.matchCount != null ? patch.matchCount : state.matchCount) | 0);
      const tc = Math.max(1, (patch.tableCount != null ? patch.tableCount : state.tableCount) | 0);
      // 既存データ温存でリサイズ
      const next = buildMatches(mc, tc);
      for (let m = 0; m < mc; m++) {
        const om = state.matches[m];
        if (!om) continue;
        for (let t = 0; t < tc; t++) {
          const old = om.tables[t];
          if (old) {
            if (Array.isArray(old.seats)) next[m].tables[t].seats = old.seats.slice(0, SEATS_PER_TABLE);
            if (old.placements) next[m].tables[t].placements = old.placements;
          }
        }
        next[m].present = om.present || null;
      }
      state.matches = next;
      state.matchCount = mc;
      state.tableCount = tc;
      save();
    }

    /* ---- ログインユーザーの登録（upsert）----
       権限に関係なく「自分自身」だけは登録・更新できる（＝自己登録）。
       同じ discord.id なら情報を最新化（ランク・ロール・アバター）。
       ★ nameLocked が立っている選手は、管理者が付けた表示名を保持する。 */
    /* 自分が roster から消えていたら入れ直す。
       他の人の書き込みで roster が丸ごと置き換わったとき（最後の書き手が勝つため）や、
       入場直後に最初のスナップショットが届いたときに効く。自己修復用。 */
    function ensureSelf() {
      if (!selfSession) return;
      const p = Session.toPlayer(selfSession);
      if (!p) return;
      if (state.roster.some(x => x.id === p.id)) return;
      p.joinedAt = Date.now();
      state.roster.push(p);
      save();
    }

    function upsertSelf(session) {
      selfSession = session || selfSession;
      const p = Session.toPlayer(session);
      if (!p) return null;
      const i = state.roster.findIndex(x => x.id === p.id);
      if (i >= 0) {
        const prev = state.roster[i];
        const merged = Object.assign({}, prev, p, { joinedAt: prev.joinedAt || Date.now() });
        if (prev.nameLocked) { merged.name = prev.name; merged.nameLocked = true; }
        // 管理者が立場（先生/生徒）を変えていたら、本人の再ログインで戻さない
        if (prev.kindLocked) {
          merged.roles = prev.roles;
          merged.kindLocked = true;
          if (merged.discord) merged.discord = Object.assign({}, merged.discord, { kind: kindOf(prev) });
        }
        merged.optIn = !!prev.optIn;   // 管理者が付けた「参加させる」は再ログインで消さない
        state.roster[i] = merged;
      } else {
        p.joinedAt = Date.now();
        state.roster.push(p);
      }
      save();
      return p.id;
    }
    /* ログイン済みメンバー（全体名簿）を、このボードの名簿に取り込む。
       すでに居る人はそのまま（表示名・大会に参加 の設定を壊さない）。 */
    function mergeMembers(list) {
      if (!guard("メンバーの取り込み")) return 0;
      let added = 0;
      (list || []).forEach(m => {
        if (!m || !m.id) return;
        if (state.roster.some(x => x.id === m.id)) return;
        state.roster.push(Object.assign({}, m, { joinedAt: m.joinedAt || Date.now() }));
        added++;
      });
      if (added) save();
      return added;
    }
    function updatePlayer(pid, patch) {
      if (!guard("選手情報の編集")) return;
      const p = state.roster.find(x => x.id === pid);
      if (!p) return;
      Object.assign(p, patch, { updatedAt: Date.now() });
      save();
    }
    /* 立場（先生/生徒）の手動変更。
       "" を渡すとロック解除＝次回ログインで本人が選んだものに戻る。 */
    function setPlayerKind(pid, kind) {
      if (!guard("立場の変更")) return;
      const p = state.roster.find(x => x.id === pid);
      if (!p) return;
      const r = kindRole(kind);
      if (r) {
        p.roles = [r];
        p.kindLocked = true;
        if (p.discord) p.discord = Object.assign({}, p.discord, { kind: r.id });
      } else {
        p.kindLocked = false;
      }
      p.updatedAt = Date.now();
      save();
    }
    // 表示名の手動設定（空文字でロック解除＝次回ログインでDiscord名に戻る）
    function setPlayerName(pid, name) {
      if (!guard("表示名の変更")) return;
      const p = state.roster.find(x => x.id === pid);
      if (!p) return;
      const nv = (name || "").trim();
      if (nv) { p.name = nv; p.nameLocked = true; }
      else { p.nameLocked = false; p.name = (p.discord && p.discord.name) || p.name; }
      p.updatedAt = Date.now();
      save();
    }
    // 運営ロールの人を大会に参加させる / 外す（管理者のみ）
    function setOptIn(pid, on) {
      if (!guard("運営メンバーの参加切り替え")) return;
      const p = state.roster.find(x => x.id === pid);
      if (!p) return;
      p.optIn = !!on;
      p.updatedAt = Date.now();
      if (!on) {
        // 外すときは席と順位からも抜く
        state.matches.forEach(mt => {
          if (Array.isArray(mt.present)) mt.present = mt.present.filter(id => id !== pid);
          mt.tables.forEach(tb => {
            const i = tb.seats.indexOf(pid);
            if (i >= 0) tb.seats[i] = null;
            delete tb.placements[pid];
          });
        });
      }
      save();
    }
    function removePlayer(pid) {
      if (!guard("選手の削除")) return;
      state.roster = state.roster.filter(p => p.id !== pid);
      state.matches.forEach(mt => {
        if (Array.isArray(mt.present)) mt.present = mt.present.filter(id => id !== pid);
        mt.tables.forEach(tb => {
          const i = tb.seats.indexOf(pid);
          if (i >= 0) tb.seats[i] = null;
          delete tb.placements[pid];
        });
      });
      save();
    }

    /* =============================================================
       ★ チーム（ダブルアップのペア）の編集
       ポイントはチームに付くので、中身の2人を入れ替えても
       そのチームが積んだptはそのまま残ります。
       ============================================================= */
    function setMode(mode) {
      if (!guard("モードの変更")) return;
      const next = (mode === "doubleup") ? "doubleup" : "solo";
      if (state.mode === next) return;
      state.mode = next;
      // 席に入るものが変わる（選手 ↔ チーム）ので、配置と順位はいったん白紙にする
      state.matches.forEach(mt => {
        mt.present = null;
        mt.tables.forEach(tb => {
          tb.seats = new Array(slotCount(state)).fill(null);
          tb.placements = {};
        });
      });
      save();
    }
    function createTeam(members, name) {
      if (!guard("チームの作成")) return null;
      const ms = (Array.isArray(members) ? members : [])
        .filter(pid => playerById(state, pid))
        .slice(0, TEAM_SIZE);
      // ほかのチームに入っている人は先に外す
      ms.forEach(pid => {
        const t = teamOfPlayer(state, pid);
        if (t) t.members = t.members.filter(x => x !== pid);
      });
      const t = {
        id: newTeamId(), name: String(name || "").trim().slice(0, 40),
        members: ms, createdAt: Date.now(), updatedAt: Date.now()
      };
      if (!Array.isArray(state.teams)) state.teams = [];
      state.teams.push(t);
      save();
      return t.id;
    }
    function setTeamMembers(teamId, members) {
      if (!guard("チームの変更")) return;
      const t = teamById(state, teamId);
      if (!t) return;
      const ms = (Array.isArray(members) ? members : [])
        .filter(pid => playerById(state, pid))
        .slice(0, TEAM_SIZE);
      ms.forEach(pid => {
        const other = teamOfPlayer(state, pid);
        if (other && other.id !== teamId) other.members = other.members.filter(x => x !== pid);
      });
      t.members = ms;
      t.updatedAt = Date.now();
      save();
    }
    function setTeamName(teamId, name) {
      if (!guard("チーム名の変更")) return;
      const t = teamById(state, teamId);
      if (!t) return;
      t.name = String(name || "").trim().slice(0, 40);
      t.updatedAt = Date.now();
      save();
    }
    /* チームを消す。ptの履歴ごと消えるので、席と順位からも外す。 */
    function removeTeam(teamId) {
      if (!guard("チームの削除")) return;
      state.teams = teamsOf(state).filter(t => t.id !== teamId);
      state.matches.forEach(mt => {
        if (Array.isArray(mt.present)) mt.present = mt.present.filter(id => id !== teamId);
        mt.tables.forEach(tb => {
          const i = tb.seats.indexOf(teamId);
          if (i >= 0) tb.seats[i] = null;
          delete tb.placements[teamId];
        });
      });
      save();
    }
    /* ペアが決まっていない参加者を、上から2人ずつ組ませる。
       すでにあるチームは触らない。 */
    function autoPairTeams() {
      if (!guard("自動でペアを作る")) return 0;
      const rest = unpairedPlayers(state);
      let made = 0;
      for (let i = 0; i + 1 < rest.length; i += 2) {
        const t = {
          id: newTeamId(), name: "",
          members: [rest[i].id, rest[i + 1].id],
          createdAt: Date.now(), updatedAt: Date.now()
        };
        if (!Array.isArray(state.teams)) state.teams = [];
        state.teams.push(t);
        made++;
      }
      if (made) save();
      return made;
    }
    /* 空きのあるチームに1人入れる。空きが無ければ新しいチームを作る。 */
    function addToTeam(teamId, pid) {
      if (!guard("チームへの追加")) return;
      const t = teamById(state, teamId);
      if (!t || !playerById(state, pid)) return;
      if (t.members.length >= TEAM_SIZE) return;
      const other = teamOfPlayer(state, pid);
      if (other) other.members = other.members.filter(x => x !== pid);
      t.members.push(pid);
      t.updatedAt = Date.now();
      save();
    }
    function removeFromTeam(pid) {
      if (!guard("チームからの除外")) return;
      const t = teamOfPlayer(state, pid);
      if (!t) return;
      t.members = t.members.filter(x => x !== pid);
      t.updatedAt = Date.now();
      save();
    }

    /* ---- 席・順位 ---- */
    function assignSeat(matchIdx, tableIdx, seatIdx, pid) {
      if (!guard("席の配置")) return;
      const tb = state.matches[matchIdx].tables[tableIdx];
      const kicked = tb.seats[seatIdx] || null;       // そこに座っていた人（居れば押し出される）
      // 同じ試合で既に座っていたら外す
      state.matches[matchIdx].tables.forEach(x => {
        const i = x.seats.indexOf(pid);
        if (i >= 0) x.seats[i] = null;
      });
      tb.seats[seatIdx] = pid;
      if (kicked && kicked !== pid) {
        state.matches[matchIdx].tables.forEach(x => { delete x.placements[kicked]; });
      }
      save();
    }
    function clearSeat(matchIdx, tableIdx, seatIdx) {
      if (!guard("席のクリア")) return;
      const tb = state.matches[matchIdx].tables[tableIdx];
      const pid = tb.seats[seatIdx];
      tb.seats[seatIdx] = null;
      if (pid) delete tb.placements[pid];
      save();
    }
    /* ドラッグ&ドロップ用。
       席 → 席 の移動。移動先に人が居たら入れ替える（＝席交換）。
       卓をまたいだ場合は、その卓で入れた順位は意味を失うので消す。 */
    function moveSeat(matchIdx, fromT, fromS, toT, toS) {
      if (!guard("席の入れ替え")) return;
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const a = mt.tables[fromT], b = mt.tables[toT];
      if (!a || !b) return;
      if (fromT === toT && fromS === toS) return;
      const pa = a.seats[fromS] || null;
      const pb = b.seats[toS] || null;
      a.seats[fromS] = pb;
      b.seats[toS] = pa;
      if (fromT !== toT) {
        if (pa) { delete a.placements[pa]; delete b.placements[pa]; }
        if (pb) { delete a.placements[pb]; delete b.placements[pb]; }
      }
      save();
    }
    /* ドラッグ&ドロップ用。その試合の席からこの選手を外す（参加者リストへ戻す）。 */
    function unseatPlayer(matchIdx, pid) {
      if (!guard("席から外す")) return;
      const mt = state.matches[matchIdx];
      if (!mt || !pid) return;
      mt.tables.forEach(tb => {
        const i = tb.seats.indexOf(pid);
        if (i >= 0) tb.seats[i] = null;
        delete tb.placements[pid];
      });
      save();
    }
    function setPlacement(matchIdx, tableIdx, pid, rank) {
      if (!guard("順位の入力")) return;
      const tb = state.matches[matchIdx].tables[tableIdx];
      if (rank) tb.placements[pid] = rank | 0;
      else delete tb.placements[pid];
      save();
    }
    function clearMatchSeats(matchIdx) {
      if (!guard("配置のクリア")) return;
      const mt = state.matches[matchIdx];
      if (!mt) return;
      mt.tables.forEach(tb => { tb.seats = new Array(slotCount(state)).fill(null); tb.placements = {}; });
      save();
    }
    function clearAllResults() {
      if (!guard("全結果のクリア")) return;
      state.matches.forEach(mt => mt.tables.forEach(tb => { tb.placements = {}; }));
      save();
    }
    function resetBoard() {
      if (!guard("ボードの初期化")) return;
      const roster = state.roster; // ログイン済みメンバーは残す
      state = blankState();
      state.roster = roster;
      save();
    }
    function importState(obj) {
      if (!guard("バックアップからの復元")) return;
      state = normalize(obj);
      save();
    }
    function loadBoardState(id) {
      // 読み取り専用で別ボードの状態を取得
      return (async () => {
        if (mode === "firestore" && db) {
          const snap = await db.collection(COL).doc(docIdOf(id)).get();
          return snap.exists ? normalize(snap.data()) : null;
        }
        const raw = localStorage.getItem(LSP + ":" + gkey + ":" + id);
        return raw ? normalize(JSON.parse(raw)) : null;
      })();
    }

    /* ---- 参加者（出席）管理 ----
       ★ ダブルアップでは「チーム単位」で出欠を持ちます。
         自分のチェックを外すと、相方ごと外れます（1人だけ出ることはできないため）。 */
    function materializePresent(matchIdx) {
      const mt = state.matches[matchIdx];
      if (!mt) return [];
      if (!Array.isArray(mt.present)) mt.present = unitsOf(state);
      return mt.present;
    }
    // その試合からこのユニットを外す（席と順位も消す）
    function dropUnit(mt, uid) {
      mt.tables.forEach(tb => {
        const si = tb.seats.indexOf(uid);
        if (si >= 0) tb.seats[si] = null;
        delete tb.placements[uid];
      });
    }
    // 一般プレイヤーは「自分の出欠」だけ切り替えられる
    function setPresent(matchIdx, pid, on) {
      if (!actor.isAdmin && pid !== actor.pid) return deny("他の選手の出欠変更");
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const uid = unitOfPlayer(state, pid);
      if (!uid) return;                    // ダブルアップでペアが未設定
      const arr = materializePresent(matchIdx);
      const i = arr.indexOf(uid);
      if (on) { if (i < 0) arr.push(uid); }
      else {
        if (i >= 0) arr.splice(i, 1);
        dropUnit(mt, uid);
      }
      save();
    }
    function setAllPresent(matchIdx, on, pids) {
      if (!guard("出欠の一括変更")) return;
      // pids を渡すとその集合だけを対象にする（ロールフィルタ用）
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const target = Array.isArray(pids)
        ? [...new Set(pids.map(pid => unitOfPlayer(state, pid)).filter(Boolean))]
        : unitsOf(state);
      const arr = materializePresent(matchIdx);
      if (on) {
        target.forEach(id => { if (!arr.includes(id)) arr.push(id); });
      } else {
        mt.present = arr.filter(id => !target.includes(id));
        target.forEach(uid => dropUnit(mt, uid));
      }
      save();
    }
    // 指定ロール保持者だけを参加にする
    function setPresentByRole(matchIdx, roleId) {
      if (!guard("ロールによる出欠の一括変更")) return;
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const keep = unitsOf(state).filter(uid =>
        unitPlayers(state, uid).some(p => hasRole(p, roleId)));
      mt.present = keep;
      unitsOf(state).forEach(uid => { if (keep.indexOf(uid) < 0) dropUnit(mt, uid); });
      save();
    }

    /* ---- 自動組卓 ----
       opts = {
         method: "random" | "points" | "roleBalance" | "roleGroup",
         roleId: roleBalance / roleGroup で使うロールID（roleGroupは省略可）,
         limitRoleId: このロール保持者だけを対象にする（省略可）
       }
       roleBalance : roleId 保持者を各卓へ均等に散らす（例: コーチを各卓1人ずつ）
       roleGroup   : 同じロールの人を同じ卓へ固める（roleId指定時はそのロール優先、
                     省略時は最上位ロールでグループ化） */
    function autoAssign(matchIdx, opts) {
      if (!guard("自動組卓")) return null;
      opts = opts || {};
      const method = opts.method || "random";
      const mt = state.matches[matchIdx];
      if (!mt) return null;
      const tableCount = state.tableCount;
      const cap = tableCount * slotCount(state);

      // ソロは選手ID、ダブルアップはチームIDが並ぶ
      let ids = presentUnits(state, matchIdx).slice();
      if (opts.limitRoleId) {
        ids = ids.filter(id => unitPlayers(state, id).some(p => hasRole(p, opts.limitRoleId)));
      }
      let dropped = 0;

      const shuffle = arr => {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      };
      const cumPts = () => {
        const pts = {};
        ids.forEach(id => { pts[id] = 0; });
        for (let m = 0; m < matchIdx; m++) {
          const pm = state.matches[m];
          if (!pm) continue;
          pm.tables.forEach(tb => tb.seats.forEach(uid => {
            if (uid && pts[uid] != null) {
              const r = tb.placements[uid];
              if (r) pts[uid] += pointsFor(state.mode, r);
            }
          }));
        }
        return pts;
      };

      if (ids.length > cap) { dropped = ids.length - cap; }

      // 卓ごとの定員（均等配分）
      const useCount = Math.min(ids.length, cap);
      const counts = new Array(tableCount).fill(0);
      {
        const base = Math.floor(useCount / tableCount), rem = useCount % tableCount;
        for (let t = 0; t < tableCount; t++) counts[t] = base + (t < rem ? 1 : 0);
      }

      // 席リセット
      mt.tables.forEach(tb => { tb.seats = new Array(slotCount(state)).fill(null); tb.placements = {}; });
      const fill = new Array(tableCount).fill(0);
      const put = (t, pid) => {
        if (fill[t] >= counts[t]) return false;
        mt.tables[t].seats[fill[t]++] = pid;
        return true;
      };

      if (method === "points") {
        const pts = cumPts();
        ids.sort((a, b) => (pts[b] - pts[a]) || (Math.random() - 0.5));
        let idx = 0;
        for (let t = 0; t < tableCount && idx < ids.length; t++)
          while (fill[t] < counts[t] && idx < ids.length) put(t, ids[idx++]);
      } else if (method === "roleBalance" && opts.roleId) {
        const hasR = id => unitPlayers(state, id).some(p => hasRole(p, opts.roleId));
        const withRole = shuffle(ids.filter(hasR));
        const rest = shuffle(ids.filter(id => !hasR(id)));
        // ロール保持者を卓0,1,2...へ順に散らす
        let t = 0;
        withRole.forEach(pid => {
          let tries = 0;
          while (!put(t % tableCount, pid) && tries < tableCount) { t++; tries++; }
          t++;
        });
        // 残りは空きの多い卓から
        rest.forEach(pid => {
          let best = -1, bestRoom = -1;
          for (let k = 0; k < tableCount; k++) {
            const room = counts[k] - fill[k];
            if (room > bestRoom) { bestRoom = room; best = k; }
          }
          if (best >= 0 && bestRoom > 0) put(best, pid);
        });
      } else if (method === "roleGroup") {
        // グループキー: roleId指定→そのロールの有無 / 未指定→最上位ロールID
        const keyOf = id => {
          const ps = unitPlayers(state, id);
          if (opts.roleId) return ps.some(p => hasRole(p, opts.roleId)) ? "in" : "out";
          const p = ps[0];
          return (p && p.roles && p.roles[0] && p.roles[0].id) || "_none";
        };
        const groups = {};
        shuffle(ids).forEach(pid => {
          const k = keyOf(pid);
          (groups[k] = groups[k] || []).push(pid);
        });
        // 大きいグループから卓へ詰める
        const ordered = Object.values(groups).sort((a, b) => b.length - a.length);
        const flat = [];
        ordered.forEach(g => flat.push(...g));
        let idx = 0;
        for (let t = 0; t < tableCount && idx < flat.length; t++)
          while (fill[t] < counts[t] && idx < flat.length) put(t, flat[idx++]);
      } else {
        shuffle(ids);
        let idx = 0;
        for (let t = 0; t < tableCount && idx < ids.length; t++)
          while (fill[t] < counts[t] && idx < ids.length) put(t, ids[idx++]);
      }

      save();
      return { assigned: Math.min(ids.length, cap), dropped, capacity: cap };
    }

    return {
      init, onChange, save,
      get state() { return state; },
      get mode() { return mode; },
      get boardId() { return boardId; },
      setActor, getActor, canEdit,
      setMode, createTeam, setTeamMembers, setTeamName, removeTeam,
      autoPairTeams, addToTeam, removeFromTeam,
      setSettings, upsertSelf, updatePlayer, setPlayerName, setPlayerKind, removePlayer, setOptIn,
      assignSeat, clearSeat, moveSeat, unseatPlayer, setPlacement, mergeMembers,
      clearMatchSeats, clearAllResults, resetBoard, importState, loadBoardState,
      setPresent, setAllPresent, setPresentByRole, autoAssign,
      listBoards, setBoardTitle, setVisibility,
      _persistNow: persist
    };
  }

  /* =============================================================
     ボード一覧（HOME用）— 特定のボードを開かずに索引だけ読む
     makeStore().init() と違い、default ボードを作ってしまわない。
     ============================================================= */

  function openDb() {
    const fb = CFG.firebase || {};
    const hasFb = fb.apiKey && fb.projectId && typeof window.firebase !== "undefined" && firebase.firestore;
    if (!hasFb) return null;
    if (!firebase.apps.length) firebase.initializeApp(fb);
    return firebase.firestore();
  }
  async function listAllBoards() {
    const db = openDb();
    let map = {};
    try {
      if (db) {
        const snap = await db.collection(ICOL).doc(registryDocId()).get();
        if (snap.exists) Object.entries((snap.data() || {}).boards || {}).forEach(([k, v]) => { map[decodeURIComponent(k)] = v; });
      } else {
        map = JSON.parse(localStorage.getItem(lsIndexKey()) || "{}");
      }
    } catch (e) { console.error("listAllBoards", e); }
    return Object.entries(map).map(([id, v]) => ({
      id,
      title: (v && v.title) || "",
      matchCount: (v && v.matchCount) || 0,
      tableCount: (v && v.tableCount) || 0,
      players: (v && v.players) || 0,
      visibility: normVisibility(v && v.visibility),
      updatedAt: (v && v.updatedAt) || 0
    })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  /* 大会名からボードIDを作る。日本語だけの名前なら日付ベースのIDになる。
     例: "第4回 校内カップ" → "board-20260913-4f2a" / "Camp 2026!" → "camp-2026" */
  function slugify(s) {
    const base = String(s || "").trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "");
    // 英字が1文字も残らない場合は日付ベースにする。
    // 「第4回 校内カップ」が "4" になると「第5回」= "5" と衝突しやすく、意味も分からないため。
    if (base.length >= 2 && /[a-z]/.test(base)) return base;
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    const rnd = Math.random().toString(36).slice(2, 6);
    return "board-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + rnd;
  }

  // 新規ボードを作る（管理者のみ）
  // createBoard(id, { title, visibility })   id を空にすると title から自動生成
  async function createBoard(id, opts) {
    opts = opts || {};
    id = String(id || "").trim();
    if (!id) id = slugify(opts.title);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error("ボードIDに使えるのは半角英数字・ハイフン・アンダースコアだけです（入力: " + id + "）");
    }
    if (!isAdmin()) throw new Error("ボードの作成は管理者のみです");

    const st = blankState();
    st.title = String(opts.title || "").trim();
    st.visibility = normVisibility(opts.visibility);
    const entry = {
      title: st.title, matchCount: st.matchCount, tableCount: st.tableCount,
      players: 0, visibility: st.visibility, updatedAt: st.updatedAt
    };

    const db = openDb();
    if (db) {
      let snap;
      try { snap = await db.collection(COL).doc(boardDocId(id)).get(); }
      catch (e) { throw new Error("Firestore を読めませんでした（" + (e.code || e.message) + "）。セキュリティルールに " + COL + " / " + ICOL + " を追加しているか確認してください"); }
      if (snap.exists) throw new Error("そのボードIDは既に使われています: " + id);
      try {
        await db.collection(COL).doc(boardDocId(id)).set(st);
        await db.collection(ICOL).doc(registryDocId())
          .set({ boards: { [encodeURIComponent(id)]: entry } }, { merge: true });
      } catch (e) {
        throw new Error("Firestore に書き込めませんでした（" + (e.code || e.message) + "）");
      }
    } else {
      if (localStorage.getItem(lsBoardKey(id))) throw new Error("そのボードIDは既に使われています: " + id);
      localStorage.setItem(lsBoardKey(id), JSON.stringify(st));
      const idx = JSON.parse(localStorage.getItem(lsIndexKey()) || "{}");
      idx[id] = entry;
      localStorage.setItem(lsIndexKey(), JSON.stringify(idx));
    }
    return id;
  }

  // ボードを削除する（管理者のみ）。索引からも消す。
  async function deleteBoard(id) {
    id = String(id || "").trim();
    if (!id) throw new Error("ボードIDが必要です");
    if (!isAdmin()) throw new Error("ボードの削除は管理者のみです");
    const db = openDb();
    if (db) {
      try {
        await db.collection(COL).doc(boardDocId(id)).delete();
        await db.collection(ICOL).doc(registryDocId()).set({
          boards: { [encodeURIComponent(id)]: firebase.firestore.FieldValue.delete() }
        }, { merge: true });
      } catch (e) {
        throw new Error("削除に失敗しました（" + (e.code || e.message) + "）");
      }
    } else {
      localStorage.removeItem(lsBoardKey(id));
      const idx = JSON.parse(localStorage.getItem(lsIndexKey()) || "{}");
      delete idx[id];
      localStorage.setItem(lsIndexKey(), JSON.stringify(idx));
    }
    return id;
  }

  /* =============================================================
     集計・ヘルパー
     ============================================================= */
  function playerById(state, id) { return state.roster.find(p => p.id === id) || null; }
  function nameOf(state, id) { const p = playerById(state, id); return p ? p.name : "—"; }
  function avatarOf(state, id) { const p = playerById(state, id); return (p && p.discord && p.discord.avatar) || ""; }
  function hasRole(p, roleId) { return !!(p && Array.isArray(p.roles) && p.roles.some(r => r && r.id === roleId)); }

  // ボード上の全ロール一覧（pinnedOrder → position順）
  function rosterRoles(state) {
    const map = new Map();
    participants(state).forEach(p => (p.roles || []).forEach(r => {
      if (r && r.id && !map.has(r.id)) map.set(r.id, { id: r.id, name: r.name || r.id, color: r.color || 0, count: 0 });
    }));
    participants(state).forEach(p => (p.roles || []).forEach(r => {
      if (r && r.id && map.has(r.id)) map.get(r.id).count++;
    }));
    const pinned = ((CFG.roles || {}).pinnedOrder) || [];
    return [...map.values()].sort((a, b) => {
      const pa = pinned.indexOf(a.id), pb = pinned.indexOf(b.id);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
      return a.name.localeCompare(b.name, "ja");
    });
  }
  /* Worker からロール一覧が取れないときの代替カタログ。
     ログイン中の本人が持つロール（名前つき）＋ すでに選択済みのID ＋ roster にいる人のロール
     を寄せ集める。Bot 未設定でも公開範囲の設定だけは進められるようにするための逃げ道。 */
  function fallbackRoleCatalog(session, extraIds, state) {
    const map = new Map();
    const put = r => {
      if (!r || !r.id) return;
      const id = String(r.id);
      const prev = map.get(id);
      // 名前が分かっているものを優先して残す
      if (!prev || (prev.name === id && r.name)) {
        map.set(id, { id, name: r.name || id, color: r.color || 0 });
      }
    };
    const s = session || Session.get();
    ((s && s.discord && s.discord.roles) || []).forEach(put);
    if (state && Array.isArray(state.roster)) {
      state.roster.forEach(p => (p.roles || []).forEach(put));
    }
    (extraIds || []).forEach(id => put({ id: String(id), name: null, color: 0 }));
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  function roleColorCss(color) {
    if (!color) return "var(--muted)";
    return "#" + Number(color).toString(16).padStart(6, "0");
  }

  function isPresent(state, matchIdx, pid) {
    const p = playerById(state, pid);
    if (!isParticipant(p)) return false;          // 運営ロールの人は参加扱いにしない
    const mt = state.matches[matchIdx];
    if (!mt) return true;
    const uid = isDouble(state) ? (teamOfPlayer(state, pid) || {}).id : pid;
    if (!uid) return false;                       // ダブルアップでペアが未設定
    return !Array.isArray(mt.present) ? true : mt.present.includes(uid);
  }
  // この試合に出る選手のID（ダブルアップでは参加チームの2人ぶん）
  function presentList(state, matchIdx) {
    const mt = state.matches[matchIdx];
    if (!mt) return [];
    if (isDouble(state)) {
      const ids = presentUnits(state, matchIdx);
      const out = [];
      ids.forEach(uid => teamMembers(state, uid).forEach(p => out.push(p.id)));
      return out;
    }
    const pool = participants(state);
    const set = new Set(!Array.isArray(mt.present) ? pool.map(p => p.id) : mt.present);
    return pool.filter(p => set.has(p.id)).map(p => p.id);
  }
  /* ★ この試合に出るユニットのID（ソロ=選手ID / ダブルアップ=チームID）。
     席に並べるのはこちら。 */
  function presentUnits(state, matchIdx) {
    const mt = state.matches[matchIdx];
    if (!mt) return [];
    const pool = unitsOf(state);
    const set = new Set(!Array.isArray(mt.present) ? pool : mt.present);
    return pool.filter(id => set.has(id));
  }

  /* 卓の順位。pid はユニットID（ソロ=選手 / ダブルアップ=チーム）。
     ダブルアップのときは members に2人ぶんの選手が入ります。 */
  function tableStandings(state, matchIdx, tableIdx) {
    const tb = state.matches[matchIdx].tables[tableIdx];
    const rows = [];
    tb.seats.forEach(uid => {
      if (!uid) return;
      const rank = tb.placements[uid] || null;
      rows.push({
        pid: uid, id: uid,
        name: unitName(state, uid),
        members: isDouble(state) ? teamMembers(state, uid) : [],
        rank, points: pointsFor(state.mode, rank)
      });
    });
    rows.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    return { mode: state.mode, rows };
  }

  /* 全体順位。ダブルアップでは「チームの累計pt」になります
     （ポイントは人ではなくチームに付く、という決めごとのため）。 */
  function overallStandings(state) {
    const totals = {};
    const dbl = isDouble(state);
    unitsOf(state).forEach(uid => {
      totals[uid] = {
        pid: uid, id: uid, name: unitName(state, uid),
        members: dbl ? teamMembers(state, uid) : [],
        points: 0, games: 0
      };
    });
    state.matches.forEach(mt => mt.tables.forEach(tb => {
      tb.seats.forEach(uid => {
        if (!uid || !totals[uid]) return;
        const rank = tb.placements[uid];
        if (rank) { totals[uid].points += pointsFor(state.mode, rank); totals[uid].games += 1; }
      });
    }));
    const rows = Object.values(totals).filter(r => r.games > 0 || r.points > 0);
    const list = rows.length ? rows : Object.values(totals);
    list.sort((a, b) => b.points - a.points || b.games - a.games || a.name.localeCompare(b.name, "ja"));
    return list;
  }

  /* =============================================================
     Riot / Discord API（Worker 経由）
     ============================================================= */
  async function workerGet(path, params) {
    const cfg = effCfg();
    if (!cfg.workerUrl) throw new Error("Worker URL が未設定です（config.js または管理コンソール）");
    const u = new URL(cfg.workerUrl.replace(/\/$/, "") + path);
    Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u.toString());
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("API " + res.status + " " + t.slice(0, 160));
    }
    return res.json();
  }

  const Riot = {
    enabled() { return !!effCfg().workerUrl; },

    parseRiotId(riotId) {
      const m = (riotId || "").split("#");
      if (m.length !== 2 || !m[0].trim() || !m[1].trim()) throw new Error("Riot IDは Name#TAG 形式で入力してください");
      return { gameName: m[0].trim(), tagLine: m[1].trim() };
    },
    async account(gameName, tagLine) {
      return workerGet("/account", { gameName, tagLine, region: effCfg().region });
    },
    // TFTランク（RANKED_TFTを優先。無ければ他キューか null）
    async rank(puuid) {
      const entries = await workerGet("/rank", { puuid, platform: effCfg().platform });
      if (!Array.isArray(entries) || !entries.length) return null;
      const pickQ = q => entries.find(e => e.queueType === q);
      const e = pickQ("RANKED_TFT") || pickQ("RANKED_TFT_DOUBLE_UP") || entries[0];
      if (!e) return null;
      return {
        queue: e.queueType || "",
        tier: e.tier || (e.ratedTier ? "RATED" : ""),   // ハイパーロール等はratedTier
        division: e.rank || "",
        lp: e.leaguePoints != null ? e.leaguePoints : (e.ratedRating != null ? e.ratedRating : 0),
        wins: e.wins || 0, losses: e.losses || 0
      };
    },
    // Riot ID → { gameName, tagLine, puuid, rank }
    async lookup(riotId) {
      const { gameName, tagLine } = this.parseRiotId(riotId);
      const acc = await this.account(gameName, tagLine);
      let rank = null;
      try { rank = await this.rank(acc.puuid); } catch (e) { console.warn("rank fetch failed", e); }
      return { gameName: acc.gameName || gameName, tagLine: acc.tagLine || tagLine, puuid: acc.puuid, rank };
    },
    async recentMatches(puuid, count) {
      return workerGet("/matches", { puuid, count: count || 20, region: effCfg().region });
    },
    async match(matchId) {
      return workerGet("/match", { matchId, region: effCfg().region });
    },

    /* 卓のメンバーを含む直近マッチを探して順位を返す。
       ★ 8人が全員このコミュニティの人とは限らないので、「全員揃ったマッチ」ではなく
         「最も多く一致したマッチ」を採用する。最低 min 人（既定2人）一致すればよい。

       players: [{pid, puuid}]（puuid未登録の人は最初から除外）
       opts: { min: 最低一致人数, count: 1人あたり見る試合数, budget: 詳細取得の上限 }
       戻り値: { matchId, placements:{pid:rank}, matched, total, missingPids } or null */
    /* 卓の順位を Riot の履歴から拾う。

       players = [{ pid, puuid }]                     … 個人戦
                 [{ pid, puuids:[puuid, puuid] }]     … ダブルアップ（pid はチームID）

       opts.mode === "doubleup" のときは、
         ・ダブルアップの試合（tft_game_type === "pairs"）だけを見る
         ・順位が 1〜8 で返ってきたら 1〜4 に直す（ceil(placement/2)）
         ・partner_group_id があれば、2人が同じ組かどうかも確かめる
       ※ Riot 側が 1〜4 と 1〜8 のどちらで返すかは試合によって変わりうるので、
         その場の最大値を見て決めています。 */
    async autoDetectTable(players, onProgress, opts) {
      opts = opts || {};
      const dbl = opts.mode === "doubleup";
      const min = Math.max(2, opts.min || 2);
      const count = opts.count || 20;
      const budget = opts.budget || 30;      // マッチ詳細の取得回数上限（レート制限対策）

      // 1件につき puuid が1個（個人戦）か2個（ダブルアップ）
      const puOf = p => (Array.isArray(p.puuids) && p.puuids.length)
        ? p.puuids.filter(Boolean)
        : (p.puuid ? [p.puuid] : []);

      const valid = players.filter(p => puOf(p).length);
      if (valid.length < min) {
        throw new Error(dbl
          ? ("ログイン済み（puuid登録済み）のチームが" + min + "組以上必要です。現在" + valid.length + "組")
          : ("ログイン済み（puuid登録済み）の選手が" + min + "人以上必要です。現在" + valid.length + "人"));
      }

      // 履歴を見る起点。先頭が未プレイでも拾えるよう複数人ぶん辿る
      const bases = [];
      valid.forEach(p => puOf(p).forEach(u => {
        if (bases.length < 3) bases.push({ pid: p.pid, puuid: u });
      }));
      const seen = new Set();
      let fetched = 0;
      let best = null;

      const isPairs = detail => {
        const info = detail.info || {};
        const q = String(info.queue_id == null ? "" : info.queue_id);
        return info.tft_game_type === "pairs" || q === "1150" || q === "1160";
      };

      for (const base of bases) {
        let ids = [];
        onProgress && onProgress(base.pid + " の履歴を取得中…");
        try { ids = await Riot.recentMatches(base.puuid, count); } catch (e) { continue; }

        for (const matchId of ids) {
          if (seen.has(matchId)) continue;
          seen.add(matchId);
          if (fetched >= budget) break;
          fetched++;
          onProgress && onProgress("照合中 " + fetched + "件目…");

          let detail;
          try { detail = await Riot.match(matchId); } catch (e) { continue; }
          // ダブルアップのときは、ダブルアップの試合だけを見る
          if (dbl && !isPairs(detail)) continue;
          const parts = (detail.info && detail.info.participants) || [];
          const partPuuids = new Set(parts.map(x => x.puuid));
          const hit = valid.filter(p => puOf(p).some(u => partPuuids.has(u)));
          if (hit.length < min) continue;

          const when = (detail.info && detail.info.game_datetime) || 0;
          if (!best || hit.length > best.hit.length || (hit.length === best.hit.length && when > best.when)) {
            best = { matchId, hit, parts, when, pairs: isPairs(detail) };
          }
          if (best.hit.length === valid.length) break;   // 全員揃ったら即決
        }
        if (best && best.hit.length === valid.length) break;
        if (fetched >= budget) break;
      }

      if (!best) return null;

      // ダブルアップ：1〜8で返ってきていたら1〜4に直す
      let scale = 1;
      if (dbl) {
        const mx = best.parts.reduce((a, x) => Math.max(a, x.placement | 0), 0);
        if (mx > 4) scale = 2;
      }
      const placements = {};
      const splitTeams = [];          // 2人が別チーム扱いになっていた（＝ペアが違う）
      best.hit.forEach(p => {
        const mine = best.parts.filter(x => puOf(p).includes(x.puuid));
        if (!mine.length) return;
        const raw = mine[0].placement | 0;
        placements[p.pid] = (scale === 2) ? Math.max(1, Math.ceil(raw / 2)) : raw;
        // partner_group_id が取れていて、2人の組が違うなら教える
        if (dbl && mine.length === 2) {
          const g0 = mine[0].partner_group_id, g1 = mine[1].partner_group_id;
          if (g0 != null && g1 != null && g0 !== g1) splitTeams.push(p.pid);
        }
      });
      const hitPids = new Set(best.hit.map(p => p.pid));
      return {
        matchId: best.matchId,
        placements,
        matched: best.hit.length,
        total: valid.length,
        missingPids: valid.filter(p => !hitPids.has(p.pid)).map(p => p.pid),
        // ダブルアップのときの追加情報
        doubleup: !!dbl,
        pairsMatch: !!best.pairs,
        scaled: scale === 2,          // 1〜8 → 1〜4 に直した
        splitTeams: splitTeams
      };
    }
  };

  const DiscordAuth = {
    enabled() { return !!effCfg().workerUrl; },
    // Discordログインへ移動（戻り先=現在のページ）
    login(returnUrl) {
      const cfg = effCfg();
      if (!cfg.workerUrl) throw new Error("Worker URL が未設定です（config.js）");
      const ret = returnUrl || (location.origin + location.pathname + location.search);
      location.href = cfg.workerUrl.replace(/\/$/, "") + "/auth/login?return=" + encodeURIComponent(ret);
    },
    // URLフラグメント #dc=... を読んで結果を返す（読んだら消す）
    consumeCallback() {
      const m = (location.hash || "").match(/#dc=([^&]+)/);
      if (!m) return null;
      history.replaceState(null, "", location.pathname + location.search);
      try {
        const s = m[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = s + "===".slice((s.length + 3) % 4);
        return JSON.parse(decodeURIComponent(escape(atob(pad))));
      } catch (e) { return { ok: false, error: "コールバックの解析に失敗しました" }; }
    },
    /* ★ この版はDiscordサーバーのロールを問い合わせません。
       ロール一覧＝ 先生 / 生徒 の2つで固定です。
       （Worker の /roles・/member は呼ばないので、Botの設定もサーバー参加も不要） */
    async rolesCached() {
      return KIND_ROLES.map(r => Object.assign({}, r));
    }
  };

  /* ---- ランク表示ヘルパー ---- */
  const TIER_COLORS = {
    IRON: "#8a8a8a", BRONZE: "#a86a3d", SILVER: "#9fb4c7", GOLD: "#e0a52e",
    PLATINUM: "#3fbaa5", EMERALD: "#2fae62", DIAMOND: "#5aa3e8",
    MASTER: "#b04ee0", GRANDMASTER: "#e04e4e", CHALLENGER: "#38c8e8", RATED: "#d94e97"
  };
  function rankLabel(rank) {
    if (!rank || !rank.tier) return "ランクなし";
    const div = /^(MASTER|GRANDMASTER|CHALLENGER|RATED)$/.test(rank.tier) ? "" : (" " + (rank.division || ""));
    return rank.tier + div + " " + (rank.lp | 0) + "LP";
  }
  function rankColor(rank) { return (rank && TIER_COLORS[rank.tier]) || "var(--muted)"; }

  /* ---- 公開 ---- */
  window.LBCore = {
    VERSION: "cup-1.5",           // 各ページはこれを見て core.js が古くないか判定する
    SEATS_PER_TABLE,
    pointsFor, makeStore,
    playerById, nameOf, avatarOf,
    hasRole, rosterRoles, roleColorCss, fallbackRoleCatalog,
    KIND_ROLES, kindRole, kindLabel, kindOf, kindRolesOf,
    Groups, fsErr,
    isStaff, isParticipant, participants, staffRoleIds,
    isAdmin, isAdminConfigured, adminConfig,
    normVisibility, canViewBoard, visibilityLabel,
    listAllBoards, createBoard, deleteBoard, slugify,
    isPresent, presentList, presentUnits,
    isDouble, slotCount, SEATS_PER_TABLE_SOLO: 8, TEAMS_PER_TABLE, TEAM_SIZE,
    teamsOf, teamById, teamOfPlayer, teamMembers, teamLabel, unpairedPlayers,
    unitsOf, unitName, unitPlayers, unitOfPlayer,
    tableStandings, overallStandings,
    Riot, DiscordAuth, RiotConfig, Session,
    rankLabel, rankColor
  };
})();
