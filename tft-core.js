/* =============================================================
   tft-core.js  —  共通コアロジック
   データ模型 / 得点計算 / Firestore同期 / Riot API(Worker経由)
   index.html と editor.html の両方が読み込みます。
   ============================================================= */
(function () {
  "use strict";

  const CFG = window.TFT_CONFIG || {};
  const SEATS_PER_TABLE = 8;

  /* ---------- モード定義 ---------- */
  const MODES = {
    solo:     { label: "個人戦",          groupSize: 1, groups: 8 },
    team:     { label: "チーム戦 (4v4)",  groupSize: 4, groups: 2 },
    doubleup: { label: "ダブルアップ",     groupSize: 2, groups: 4 }
  };

  /* ---------- 得点表 ----------
     solo / team : 順位 1-8 → 8,7,...,1 pt（チームは合計で勝敗）
     doubleup    : ペア順位 1-4 → 8,6,4,2 pt（ペア両者に付与） */
  function pointsFor(mode, rank) {
    if (!rank) return 0;
    if (mode === "doubleup") return ({ 1: 8, 2: 6, 3: 4, 4: 2 })[rank] || 0;
    return Math.max(0, SEATS_PER_TABLE + 1 - rank); // 9 - rank
  }

  /* ---------- 空ボード生成 ---------- */
  function emptyTable() {
    return { seats: new Array(SEATS_PER_TABLE).fill(null), placements: {} };
  }
  function buildMatches(matchCount, tableCount) {
    const matches = [];
    for (let m = 0; m < matchCount; m++) {
      const tables = [];
      for (let t = 0; t < tableCount; t++) tables.push(emptyTable());
      matches.push({ tables });
    }
    return matches;
  }
  function blankState() {
    const d = CFG.defaults || {};
    const mc = d.matchCount || 3, tc = d.tableCount || 2, mode = d.mode || "solo";
    return {
      mode,
      matchCount: mc,
      tableCount: tc,
      roster: [],                       // [{id,name,riotId}]
      matches: buildMatches(mc, tc),
      updatedAt: Date.now()
    };
  }

  /* ---------- リサイズ（試合数/卓数の増減時にデータ温存）---------- */
  function resizeState(state, matchCount, tableCount) {
    const next = buildMatches(matchCount, tableCount);
    for (let m = 0; m < matchCount; m++) {
      for (let t = 0; t < tableCount; t++) {
        const old = state.matches[m] && state.matches[m].tables[t];
        if (old) next[m].tables[t] = old;
      }
    }
    state.matches = next;
    state.matchCount = matchCount;
    state.tableCount = tableCount;
  }

  /* =============================================================
     Store : 状態管理 + 同期（Firestore があれば共有 / 無ければ localStorage）
     ============================================================= */
  function makeStore() {
    let state = blankState();
    let listeners = [];
    let boardId = "default";
    let mode = "local";          // "firestore" | "local"
    let db = null;
    let docRef = null;
    let applyingRemote = false;
    let saveTimer = null;

    function getBoardId() {
      const p = new URLSearchParams(location.search);
      return p.get("board") || "default";
    }

    function emit() { listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }

    function onChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; }

    /* ---- 初期化 ---- */
    async function init() {
      boardId = getBoardId();
      const fb = CFG.firebase || {};
      const hasFb = fb.apiKey && fb.projectId &&
        typeof window.firebase !== "undefined" && firebase.firestore;

      if (hasFb) {
        try {
          if (!firebase.apps.length) firebase.initializeApp(fb);
          db = firebase.firestore();
          docRef = db.collection("boards").doc(boardId);
          mode = "firestore";

          const snap = await docRef.get();
          if (!snap.exists) {
            await docRef.set(blankState());
          }
          docRef.onSnapshot(s => {
            if (!s.exists) return;
            applyingRemote = true;
            state = normalize(s.data());
            applyingRemote = false;
            emit();
          }, err => console.error("onSnapshot", err));
          return { mode, boardId };
        } catch (e) {
          console.error("Firebase init failed, falling back to local:", e);
        }
      }

      // ---- localStorage フォールバック ----
      mode = "local";
      const raw = localStorage.getItem(lsKey());
      state = raw ? normalize(JSON.parse(raw)) : blankState();
      window.addEventListener("storage", e => {
        if (e.key === lsKey() && e.newValue) {
          applyingRemote = true;
          state = normalize(JSON.parse(e.newValue));
          applyingRemote = false;
          emit();
        }
      });
      emit();
      return { mode, boardId };
    }

    function lsKey() { return "tftboard:" + boardId; }

    /* ---- 受信データの形を整える（壊れ防止）---- */
    function normalize(data) {
      const s = Object.assign(blankState(), data || {});
      if (!MODES[s.mode]) s.mode = "solo";
      s.matchCount = Math.max(1, s.matchCount | 0 || 1);
      s.tableCount = Math.max(1, s.tableCount | 0 || 1);
      if (!Array.isArray(s.roster)) s.roster = [];
      if (!Array.isArray(s.matches)) s.matches = buildMatches(s.matchCount, s.tableCount);
      // 卓数/試合数とmatchesの整合
      for (let m = 0; m < s.matchCount; m++) {
        if (!s.matches[m]) s.matches[m] = { tables: [] };
        if (!Array.isArray(s.matches[m].tables)) s.matches[m].tables = [];
        for (let t = 0; t < s.tableCount; t++) {
          const tb = s.matches[m].tables[t];
          if (!tb) s.matches[m].tables[t] = emptyTable();
          else {
            if (!Array.isArray(tb.seats)) tb.seats = new Array(SEATS_PER_TABLE).fill(null);
            while (tb.seats.length < SEATS_PER_TABLE) tb.seats.push(null);
            tb.seats.length = SEATS_PER_TABLE;
            if (!tb.placements || typeof tb.placements !== "object") tb.placements = {};
          }
        }
      }
      return s;
    }

    /* ---- 保存（デバウンス）---- */
    function save() {
      if (applyingRemote) return;
      state.updatedAt = Date.now();
      emit(); // 自分の画面は即時反映
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 250);
    }
    async function persist() {
      try {
        if (mode === "firestore" && docRef) {
          await docRef.set(JSON.parse(JSON.stringify(state)));
        } else {
          localStorage.setItem(lsKey(), JSON.stringify(state));
        }
      } catch (e) { console.error("persist failed", e); }
    }

    /* ---- ミューテーション群 ---- */
    function genId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    function setSettings({ matchCount, tableCount, mode: m }) {
      if (m && MODES[m] && m !== state.mode) {
        // モード変更時は座席と順位をクリア（解釈が変わるため）
        state.mode = m;
        state.matches.forEach(mt => mt.tables.forEach(tb => {
          tb.seats = new Array(SEATS_PER_TABLE).fill(null);
          tb.placements = {};
        }));
      }
      const mc = matchCount != null ? Math.max(1, matchCount | 0) : state.matchCount;
      const tc = tableCount != null ? Math.max(1, tableCount | 0) : state.tableCount;
      resizeState(state, mc, tc);
      save();
    }

    function addPlayer(name, riotId) {
      name = (name || "").trim();
      if (!name) return null;
      const exists = state.roster.find(p => p.name === name);
      if (exists) {
        if (riotId) { exists.riotId = riotId.trim(); save(); }
        return exists;
      }
      const p = { id: genId(), name, riotId: (riotId || "").trim() };
      state.roster.push(p);
      save();
      return p;
    }
    function updatePlayer(id, patch) {
      const p = state.roster.find(x => x.id === id);
      if (!p) return;
      Object.assign(p, patch);
      save();
    }
    function removePlayer(id) {
      state.roster = state.roster.filter(p => p.id !== id);
      // 座席と順位からも除去
      state.matches.forEach(mt => mt.tables.forEach(tb => {
        tb.seats = tb.seats.map(s => (s === id ? null : s));
        delete tb.placements[id];
      }));
      save();
    }

    function assignSeat(matchIdx, tableIdx, seatIdx, playerId) {
      const tb = state.matches[matchIdx].tables[tableIdx];
      // 同じ卓内に既にいれば元の席を空ける
      const cur = tb.seats.indexOf(playerId);
      if (cur >= 0) tb.seats[cur] = null;
      tb.seats[seatIdx] = playerId;
      save();
    }
    function clearSeat(matchIdx, tableIdx, seatIdx) {
      const tb = state.matches[matchIdx].tables[tableIdx];
      const pid = tb.seats[seatIdx];
      tb.seats[seatIdx] = null;
      if (pid) delete tb.placements[pid];
      save();
    }
    function setPlacement(matchIdx, tableIdx, playerId, rank) {
      const tb = state.matches[matchIdx].tables[tableIdx];
      if (rank == null || rank === "" || isNaN(rank)) delete tb.placements[playerId];
      else tb.placements[playerId] = Math.max(1, Math.min(SEATS_PER_TABLE, parseInt(rank, 10)));
      save();
    }
    function clearMatchSeats(matchIdx) {
      state.matches[matchIdx].tables.forEach(tb => {
        tb.seats = new Array(SEATS_PER_TABLE).fill(null);
        tb.placements = {};
      });
      save();
    }
    function clearAllResults() {
      state.matches.forEach(mt => mt.tables.forEach(tb => { tb.placements = {}; }));
      save();
    }
    function resetBoard() { state = blankState(); save(); }
    function importState(obj) { state = normalize(obj); save(); }

    return {
      init, onChange, save,
      get state() { return state; },
      get mode() { return mode; },
      get boardId() { return boardId; },
      setSettings, addPlayer, updatePlayer, removePlayer,
      assignSeat, clearSeat, setPlacement,
      clearMatchSeats, clearAllResults, resetBoard, importState,
      _persistNow: persist
    };
  }

  /* =============================================================
     集計
     ============================================================= */
  function playerById(state, id) { return state.roster.find(p => p.id === id) || null; }
  function nameOf(state, id) { const p = playerById(state, id); return p ? p.name : "—"; }

  // 卓ごとの順位表
  function tableStandings(state, matchIdx, tableIdx) {
    const tb = state.matches[matchIdx].tables[tableIdx];
    const mode = state.mode;
    const M = MODES[mode];
    const rows = [];

    if (mode === "solo") {
      tb.seats.forEach(pid => {
        if (!pid) return;
        const rank = tb.placements[pid] || null;
        rows.push({ pid, name: nameOf(state, pid), rank, points: pointsFor(mode, rank) });
      });
      rows.sort((a, b) => (a.rank || 99) - (b.rank || 99));
      return { mode, rows };
    }

    if (mode === "team") {
      const teams = [[], []];
      tb.seats.forEach((pid, i) => {
        const tIdx = i < 4 ? 0 : 1;
        if (pid) {
          const rank = tb.placements[pid] || null;
          teams[tIdx].push({ pid, name: nameOf(state, pid), rank, points: pointsFor(mode, rank) });
        }
      });
      const teamData = teams.map((members, i) => ({
        team: i + 1,
        members: members.sort((a, b) => (a.rank || 99) - (b.rank || 99)),
        total: members.reduce((s, x) => s + x.points, 0)
      }));
      teamData.sort((a, b) => b.total - a.total);
      return { mode, teams: teamData };
    }

    // doubleup
    const pairs = [];
    for (let g = 0; g < 4; g++) {
      const a = tb.seats[g * 2], b = tb.seats[g * 2 + 1];
      if (!a && !b) continue;
      // ペアの順位は両者同じ想定（どちらかに入っていれば採用）
      const rank = tb.placements[a] || tb.placements[b] || null;
      pairs.push({
        pair: g + 1,
        members: [a, b].filter(Boolean).map(pid => ({ pid, name: nameOf(state, pid) })),
        rank, points: pointsFor(mode, rank)
      });
    }
    pairs.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    return { mode, pairs };
  }

  // 全体順位（全モード共通：個人の累計pt）
  function overallStandings(state) {
    const totals = {};
    state.roster.forEach(p => { totals[p.id] = { pid: p.id, name: p.name, points: 0, games: 0 }; });
    state.matches.forEach(mt => mt.tables.forEach(tb => {
      tb.seats.forEach(pid => {
        if (!pid || !totals[pid]) return;
        const rank = tb.placements[pid];
        if (rank) {
          totals[pid].points += pointsFor(state.mode, rank);
          totals[pid].games += 1;
        }
      });
    }));
    const rows = Object.values(totals).filter(r => r.games > 0 || r.points > 0);
    // 出走していない人も roster にいれば0ptで表示したい場合は↑のfilterを外す
    const all = Object.values(totals);
    const list = (rows.length ? rows : all);
    list.sort((a, b) => b.points - a.points || b.games - a.games || a.name.localeCompare(b.name, "ja"));
    return list;
  }

  /* =============================================================
     Riot API（Worker 経由）
     ============================================================= */
  const Riot = {
    enabled() { return !!(CFG.workerUrl); },

    async _get(path, params) {
      if (!CFG.workerUrl) throw new Error("Worker URL が未設定です（config.js）");
      const u = new URL(CFG.workerUrl.replace(/\/$/, "") + path);
      Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
      u.searchParams.set("region", CFG.region || "asia");
      const res = await fetch(u.toString());
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("API " + res.status + " " + t.slice(0, 120));
      }
      return res.json();
    },

    // Riot ID "Name#TAG" → puuid
    async puuid(riotId) {
      const m = (riotId || "").split("#");
      if (m.length !== 2) throw new Error("Riot IDは Name#TAG 形式で入力してください: " + riotId);
      const data = await this._get("/account", { gameName: m[0].trim(), tagLine: m[1].trim() });
      return data.puuid;
    },

    async recentMatches(puuid, count) {
      return this._get("/matches", { puuid, count: count || 20 });
    },

    async match(matchId) {
      return this._get("/match", { matchId });
    },

    /* 卓の全員を含む直近マッチを自動検出して順位を返す
       playersWithRiot: [{pid, riotId}]
       戻り値: { matchId, placements: {pid: rank}, missing: [pid...] } or null */
    async autoDetectTable(playersWithRiot, onProgress) {
      const valid = playersWithRiot.filter(p => p.riotId && p.riotId.includes("#"));
      if (valid.length < 2) throw new Error("Riot ID登録済みの選手が2人以上必要です");

      // 1) 各員のpuuid
      const puuids = {};
      for (const p of valid) {
        onProgress && onProgress("PUUID取得中: " + p.riotId);
        puuids[p.pid] = await Riot.puuid(p.riotId);
      }

      // 2) 1人目の直近マッチ一覧を基準にし、全員が含まれるものを探す
      const base = valid[0];
      onProgress && onProgress("マッチ履歴を取得中…");
      const baseIds = await Riot.recentMatches(puuids[base.pid], 20);

      const targetPuuids = new Set(Object.values(puuids));
      for (const matchId of baseIds) {
        onProgress && onProgress("照合中: " + matchId);
        let detail;
        try { detail = await Riot.match(matchId); } catch (e) { continue; }
        const parts = (detail.info && detail.info.participants) || [];
        const partPuuids = new Set(parts.map(x => x.puuid));
        // 全員が含まれるか
        const allIn = [...targetPuuids].every(pu => partPuuids.has(pu));
        if (!allIn) continue;

        // 3) 順位マップ作成
        const placements = {};
        const isDouble = (detail.info && detail.info.tft_game_type === "pairs") ||
          parts.some(p => p.partner_group_id != null);

        for (const p of valid) {
          const pu = puuids[p.pid];
          const part = parts.find(x => x.puuid === pu);
          if (!part) continue;
          if (isDouble) {
            // ダブルアップ: placement(1-8) を ペア順位(1-4) に圧縮
            placements[p.pid] = Math.ceil((part.placement || 8) / 2);
          } else {
            placements[p.pid] = part.placement;
          }
        }
        return { matchId, placements, doubleup: isDouble };
      }
      return null; // 見つからず
    }
  };

  /* ---------- 公開 ---------- */
  window.TFTCore = {
    SEATS_PER_TABLE, MODES,
    pointsFor, makeStore,
    playerById, nameOf, tableStandings, overallStandings,
    Riot
  };
})();
