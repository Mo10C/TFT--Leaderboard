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
      // present: その試合の参加者pid配列。null = 全員参加（後方互換）
      matches.push({ tables, present: null });
    }
    return matches;
  }

  /* ---------- チーム戦：チーム生成（4人×N、N=卓数×2）----------
     既存のチーム（existing）があれば名前・メンバーを可能な限り温存する。 */
  function buildTeams(tableCount, existing) {
    const n = Math.max(0, tableCount | 0) * 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = existing && existing[i];
      const members = (prev && Array.isArray(prev.members)) ? prev.members.slice(0, 4) : [];
      while (members.length < 4) members.push(null);
      out.push({ name: (prev && prev.name) || ("チーム" + (i + 1)), members });
    }
    return out;
  }

  /* ---------- チーム戦：チーム編成を各試合の卓座席へ反映 ----------
     チームi → 卓 floor(i/2) の 席[(i%2)*4 .. +4)。全試合で固定。 */
  function syncTeamSeats(state) {
    if (state.mode !== "team") return;
    const teams = state.teams || [];
    state.matches.forEach(mt => {
      mt.tables.forEach((tb, tableIdx) => {
        for (let side = 0; side < 2; side++) {
          const team = teams[tableIdx * 2 + side] || { members: [] };
          for (let k = 0; k < 4; k++) {
            tb.seats[side * 4 + k] = team.members[k] || null;
          }
        }
      });
    });
  }

  /* ---------- ダブルアップ：ペア生成（2人×N、N=卓数×4）----------
     既存のペア（existing）があれば名前・メンバーを可能な限り温存する。 */
  function buildPairs(tableCount, existing) {
    const n = Math.max(0, tableCount | 0) * 4;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = existing && existing[i];
      const members = (prev && Array.isArray(prev.members)) ? prev.members.slice(0, 2) : [];
      while (members.length < 2) members.push(null);
      out.push({ name: (prev && prev.name) || ("ペア" + (i + 1)), members });
    }
    return out;
  }

  /* ---------- ダブルアップ：ペア編成を各試合の卓座席へ反映 ----------
     ペアi → 卓 floor(i/4) の 席[(i%4)*2 .. +2)。全試合で固定。 */
  function syncPairSeats(state) {
    if (state.mode !== "doubleup") return;
    const pairs = state.pairs || [];
    state.matches.forEach(mt => {
      mt.tables.forEach((tb, tableIdx) => {
        for (let g = 0; g < 4; g++) {
          const pair = pairs[tableIdx * 4 + g] || { members: [] };
          tb.seats[g * 2] = pair.members[0] || null;
          tb.seats[g * 2 + 1] = pair.members[1] || null;
        }
      });
    });
  }

  function blankState() {
    const d = CFG.defaults || {};
    const mc = d.matchCount || 3, tc = d.tableCount || 2, mode = d.mode || "solo";
    return {
      mode,
      matchCount: mc,
      tableCount: tc,
      roster: [],                       // [{id,name,riotId,discordId,discordAvatar}]
      teams: buildTeams(tc),            // 4v4のチーム（4人×卓数×2）[{name,members:[pid,pid,pid,pid]}]
      pairs: buildPairs(tc),            // ダブルアップのペア（2人×卓数×4）[{name,members:[pid,pid]}]
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
      // 参加者リストも温存
      if (state.matches[m]) next[m].present = state.matches[m].present || null;
    }
    state.matches = next;
    state.matchCount = matchCount;
    state.tableCount = tableCount;
    state.teams = buildTeams(tableCount, state.teams);
    syncTeamSeats(state);
    state.pairs = buildPairs(tableCount, state.pairs);
    syncPairSeats(state);
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
      s.teams = buildTeams(s.tableCount, s.teams);
      s.pairs = buildPairs(s.tableCount, s.pairs);
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
        // 参加者リスト：配列なら現存rosterに絞る、それ以外は null（=全員参加）
        const pr = s.matches[m].present;
        s.matches[m].present = Array.isArray(pr)
          ? pr.filter(id => s.roster.some(p => p.id === id))
          : null;
      }
      syncTeamSeats(s);
      syncPairSeats(s);
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
        // モードが変わると参加者の意味も変わるためリセット（=全員参加）
        state.matches.forEach(mt => { mt.present = null; });
      }
      const mc = matchCount != null ? Math.max(1, matchCount | 0) : state.matchCount;
      const tc = tableCount != null ? Math.max(1, tableCount | 0) : state.tableCount;
      resizeState(state, mc, tc);
      save();
    }

    function addPlayer(name, riotId, discordId) {
      name = (name || "").trim();
      if (!name) return null;
      const exists = state.roster.find(p => p.name === name);
      if (exists) {
        if (riotId) exists.riotId = riotId.trim();
        if (discordId) exists.discordId = discordId.trim();
        if (riotId || discordId) save();
        return exists;
      }
      const p = { id: genId(), name, riotId: (riotId || "").trim(), discordId: (discordId || "").trim() };
      state.roster.push(p);
      // 既に参加者を明示している試合には、新規選手も「参加」で追加（null=全員参加はそのまま）
      state.matches.forEach(mt => { if (Array.isArray(mt.present)) mt.present.push(p.id); });
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
      state.matches.forEach(mt => {
        mt.tables.forEach(tb => {
          tb.seats = tb.seats.map(s => (s === id ? null : s));
          delete tb.placements[id];
        });
        if (Array.isArray(mt.present)) mt.present = mt.present.filter(x => x !== id);
      });
      // チーム/ペアメンバーからも除去
      if (Array.isArray(state.teams)) {
        state.teams.forEach(t => { t.members = t.members.map(m => (m === id ? null : m)); });
      }
      if (Array.isArray(state.pairs)) {
        state.pairs.forEach(p => { p.members = p.members.map(m => (m === id ? null : m)); });
      }
      save();
    }

    function assignSeat(matchIdx, tableIdx, seatIdx, playerId) {
      const tb = state.matches[matchIdx].tables[tableIdx];
      // 同じ卓内に既にいれば元の席を空ける
      const cur = tb.seats.indexOf(playerId);
      if (cur >= 0) tb.seats[cur] = null;
      tb.seats[seatIdx] = playerId;
      // 手動配置したら「参加」扱いに（参加者を明示している試合のみ）
      const mt = state.matches[matchIdx];
      if (playerId && state.mode === "solo" && Array.isArray(mt.present) && !mt.present.includes(playerId)) {
        mt.present.push(playerId);
      }
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
    function setTeamName(idx, name) {
      state.teams = buildTeams(state.tableCount, state.teams);
      if (!state.teams[idx]) return;
      state.teams[idx].name = (name || "").trim() || ("チーム" + (idx + 1));
      save();
    }
    // チーム枠(teamIdx)の メンバー席(slot 0-3)に選手(playerId)を配置。他チームに重複していれば外す。
    function setTeamMember(teamIdx, slot, playerId) {
      state.teams = buildTeams(state.tableCount, state.teams);
      if (playerId) {
        state.teams.forEach(t => {
          const i = t.members.indexOf(playerId);
          if (i >= 0) t.members[i] = null;
        });
      }
      if (state.teams[teamIdx]) state.teams[teamIdx].members[slot] = playerId || null;
      syncTeamSeats(state);
      save();
    }
    function setPairName(idx, name) {
      state.pairs = buildPairs(state.tableCount, state.pairs);
      if (!state.pairs[idx]) return;
      state.pairs[idx].name = (name || "").trim() || ("ペア" + (idx + 1));
      save();
    }
    // ペア枠(pairIdx)の メンバー席(slot 0-1)に選手(playerId)を配置。他ペアに重複していれば外す。
    function setPairMember(pairIdx, slot, playerId) {
      state.pairs = buildPairs(state.tableCount, state.pairs);
      if (playerId) {
        state.pairs.forEach(p => {
          const i = p.members.indexOf(playerId);
          if (i >= 0) p.members[i] = null;
        });
      }
      if (state.pairs[pairIdx]) state.pairs[pairIdx].members[slot] = playerId || null;
      syncPairSeats(state);
      save();
    }

    /* ---- 参加者（出席）管理：solo用。match.present(配列)で「その試合の参加者」を保持 ----
       null = 全員参加（後方互換）。配列にすると明示管理。 */
    function materializePresent(matchIdx) {
      const mt = state.matches[matchIdx];
      if (!mt) return [];
      if (!Array.isArray(mt.present)) mt.present = state.roster.map(p => p.id);
      return mt.present;
    }
    function setPresent(matchIdx, pid, on) {
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const arr = materializePresent(matchIdx);
      const i = arr.indexOf(pid);
      if (on) { if (i < 0) arr.push(pid); }
      else {
        if (i >= 0) arr.splice(i, 1);
        // 不参加にした選手はこの試合の席・順位からも外す
        mt.tables.forEach(tb => {
          const si = tb.seats.indexOf(pid);
          if (si >= 0) tb.seats[si] = null;
          delete tb.placements[pid];
        });
      }
      save();
    }
    function setAllPresent(matchIdx, on) {
      const mt = state.matches[matchIdx];
      if (!mt) return;
      if (on) mt.present = state.roster.map(p => p.id);
      else {
        mt.present = [];
        mt.tables.forEach(tb => { tb.seats = new Array(SEATS_PER_TABLE).fill(null); tb.placements = {}; });
      }
      save();
    }

    /* ---- 自動組卓（solo専用）----
       method "random"  : 参加者をシャッフルして卓に均等配分
       method "points"  : 直前までの累計ptが近い人を同卓に（高pt帯から卓1へ。同pt帯はランダム）
       戻り値: { assigned, dropped, capacity } */
    function autoAssign(matchIdx, method) {
      if (state.mode !== "solo") return null;
      const mt = state.matches[matchIdx];
      if (!mt) return null;
      const tableCount = state.tableCount;
      const cap = tableCount * SEATS_PER_TABLE;
      let ids = presentList(state, matchIdx).slice();
      let dropped = 0;

      if (method === "points") {
        const pts = {};
        ids.forEach(id => { pts[id] = 0; });
        for (let m = 0; m < matchIdx; m++) {
          const pm = state.matches[m];
          if (!pm) continue;
          pm.tables.forEach(tb => tb.seats.forEach(pid => {
            if (pid && pts[pid] != null) {
              const r = tb.placements[pid];
              if (r) pts[pid] += pointsFor(state.mode, r);
            }
          }));
        }
        // pt降順、同ptはランダムで前後
        ids.sort((a, b) => (pts[b] - pts[a]) || (Math.random() - 0.5));
      } else {
        // Fisher-Yatesシャッフル
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
      }

      if (ids.length > cap) { dropped = ids.length - cap; ids = ids.slice(0, cap); }

      // この試合をクリアしてから配分
      mt.tables.forEach(tb => { tb.seats = new Array(SEATS_PER_TABLE).fill(null); tb.placements = {}; });

      // 卓ごとの人数を均等化（端数は前の卓から）
      const counts = new Array(tableCount).fill(0);
      const base = Math.floor(ids.length / tableCount), rem = ids.length % tableCount;
      for (let t = 0; t < tableCount; t++) counts[t] = base + (t < rem ? 1 : 0);

      let idx = 0;
      for (let t = 0; t < tableCount; t++) {
        const tb = mt.tables[t];
        for (let sidx = 0; sidx < counts[t] && idx < ids.length; sidx++) tb.seats[sidx] = ids[idx++];
      }
      save();
      return { assigned: ids.length, dropped, capacity: cap };
    }

    return {
      init, onChange, save,
      get state() { return state; },
      get mode() { return mode; },
      get boardId() { return boardId; },
      setSettings, addPlayer, updatePlayer, removePlayer,
      assignSeat, clearSeat, setPlacement,
      clearMatchSeats, clearAllResults, resetBoard, importState,
      setTeamName, setTeamMember, setPairName, setPairMember,
      setPresent, setAllPresent, autoAssign,
      _persistNow: persist
    };
  }

  /* =============================================================
     集計
     ============================================================= */
  function playerById(state, id) { return state.roster.find(p => p.id === id) || null; }
  function nameOf(state, id) { const p = playerById(state, id); return p ? p.name : "—"; }
  function avatarOf(state, id) { const p = playerById(state, id); return p && p.discordAvatar ? p.discordAvatar : ""; }
  function teamName(state, idx) { return (state.teams && state.teams[idx] && state.teams[idx].name) || ("チーム" + (idx + 1)); }
  function pairName(state, idx) { return (state.pairs && state.pairs[idx] && state.pairs[idx].name) || ("ペア" + (idx + 1)); }

  // その試合にpidが参加しているか（present配列が無ければ全員参加扱い）
  function isPresent(state, matchIdx, pid) {
    const mt = state.matches[matchIdx];
    if (!mt) return true;
    return !Array.isArray(mt.present) ? true : mt.present.includes(pid);
  }
  // その試合の参加者pid一覧（roster順を維持）
  function presentList(state, matchIdx) {
    const mt = state.matches[matchIdx];
    if (!mt) return [];
    const set = new Set(!Array.isArray(mt.present) ? state.roster.map(p => p.id) : mt.present);
    return state.roster.filter(p => set.has(p.id)).map(p => p.id);
  }

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
      const teamData = teams.map((members, side) => ({
        team: tableIdx * 2 + side + 1,
        name: teamName(state, tableIdx * 2 + side),
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
        pair: tableIdx * 4 + g + 1,
        name: pairName(state, tableIdx * 4 + g),
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

  // チーム戦：全チーム（卓数×2）の通算pt。チームi → 卓floor(i/2)に固定、全試合・通算で合計。
  function teamOverall(state) {
    const teams = state.teams || [];
    const tot = teams.map((team, i) => {
      const tableIdx = Math.floor(i / 2);
      let points = 0, games = 0;
      state.matches.forEach(mt => {
        const tb = mt.tables[tableIdx];
        if (!tb) return;
        team.members.forEach(pid => {
          if (!pid) return;
          const rank = tb.placements[pid];
          if (rank) { points += pointsFor("team", rank); games += 1; }
        });
      });
      return {
        team: i + 1, name: team.name, points, games,
        members: team.members.filter(Boolean).map(pid => ({ pid, name: nameOf(state, pid), avatar: avatarOf(state, pid) }))
      };
    });
    return tot.filter(t => t.members.length || t.points).sort((a, b) => b.points - a.points);
  }

  // ダブルアップ：全ペア（卓数×4）の通算pt。ペアi → 卓floor(i/4)に固定、全試合・通算で合計。
  function pairOverall(state) {
    const pairs = state.pairs || [];
    const tot = pairs.map((pair, i) => {
      const tableIdx = Math.floor(i / 4);
      let points = 0, games = 0;
      state.matches.forEach(mt => {
        const tb = mt.tables[tableIdx];
        if (!tb) return;
        const [a, b] = pair.members;
        const rank = (a && tb.placements[a]) || (b && tb.placements[b]) || null;
        if (rank) { points += pointsFor("doubleup", rank); games += 1; }
      });
      return {
        pair: i + 1, name: pair.name, points, games,
        members: pair.members.filter(Boolean).map(pid => ({ pid, name: nameOf(state, pid), avatar: avatarOf(state, pid) }))
      };
    });
    return tot.filter(t => t.members.length || t.points).sort((a, b) => b.points - a.points);
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

  /* =============================================================
     Discord（Worker経由でアバターURLを解決）
     ============================================================= */
  const Discord = {
    enabled() { return !!CFG.workerUrl; },
    async avatar(userId) {
      if (!CFG.workerUrl) throw new Error("Worker URL が未設定です（config.js）");
      const u = new URL(CFG.workerUrl.replace(/\/$/, "") + "/avatar");
      u.searchParams.set("userId", String(userId).trim());
      const res = await fetch(u.toString());
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("avatar " + res.status + " " + t.slice(0, 140));
      }
      return res.json(); // { id, username, avatarUrl }
    }
  };

  /* ---------- 公開 ---------- */
  window.TFTCore = {
    SEATS_PER_TABLE, MODES,
    pointsFor, makeStore,
    playerById, nameOf, avatarOf, teamName, pairName,
    isPresent, presentList,
    tableStandings, overallStandings, teamOverall, pairOverall,
    Riot, Discord
  };
})();
