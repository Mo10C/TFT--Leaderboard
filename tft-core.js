/* =============================================================
   tft-core.js  —  共通コアロジック
   データ模型 / 得点計算 / Firestore同期 / Riot API(Worker経由)
   index.html と editor.html の両方が読み込みます。

   ★ v2 モデル（試合ごとに対戦カード・メンバー可変）
     - teams / pairs は「永続エンティティのプール」= [{id,name}]（名前編集可）
     - 各卓は試合ごとに seats(自由配置) を持ち、
       team は teamSlots:[teamId,teamId]（サイド0=席0-3 / サイド1=席4-7）、
       doubleup は pairSlots:[pairId×4]（グループg=席 g*2,g*2+1）で
       「この試合にどのチームがそのサイド/グループに座るか」を保持。
     - 総合順位はチーム/ペアのIDで全試合を通算集計（メンバーが試合ごとに変わってもOK）。
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

  function genId(prefix) {
    return (prefix || "p") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ---------- 空卓生成 ---------- */
  function emptyTable() {
    return {
      seats: new Array(SEATS_PER_TABLE).fill(null),
      placements: {},
      teamSlots: [null, null],           // team: サイド0/1 に座るチームID
      pairSlots: [null, null, null, null] // doubleup: グループ0-3 に座るチームID
    };
  }

  /* ---------- チーム/ペアのプール（名前編集可・IDで通算集計・既定メンバーを保持）----------
     teams : 4v4のチーム（卓数×2） pairs : ダブルアップのチーム=2人組（卓数×4）
     members = 「チーム組」タブで設定する既定メンバー（試合で卓にそのチームを選ぶと引き継がれる）。
     既存があればID・名前・メンバーを温存。 */
  function buildTeams(tableCount, existing) {
    const n = Math.max(0, tableCount | 0) * 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = existing && existing[i];
      const members = (prev && Array.isArray(prev.members)) ? prev.members.slice(0, 4) : [];
      while (members.length < 4) members.push(null);
      out.push({ id: (prev && prev.id) || genId("t"), name: (prev && prev.name) || ("チーム" + (i + 1)), members });
    }
    return out;
  }
  function buildPairs(tableCount, existing) {
    const n = Math.max(0, tableCount | 0) * 4;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = existing && existing[i];
      const members = (prev && Array.isArray(prev.members)) ? prev.members.slice(0, 2) : [];
      while (members.length < 2) members.push(null);
      out.push({ id: (prev && prev.id) || genId("g"), name: (prev && prev.name) || ("チーム" + (i + 1)), members });
    }
    return out;
  }

  // 卓tの既定スロット（table t → team[t*2],team[t*2+1] / pair[t*4..t*4+3]）
  function defaultTeamSlots(teams, t) {
    return [(teams[t * 2] && teams[t * 2].id) || null, (teams[t * 2 + 1] && teams[t * 2 + 1].id) || null];
  }
  function defaultPairSlots(pairs, t) {
    return [0, 1, 2, 3].map(g => (pairs[t * 4 + g] && pairs[t * 4 + g].id) || null);
  }
  // スロット配列を現行プールに合わせて補正（無効IDは既定へ）
  function normSlots(slots, len, pool, def) {
    const ids = new Set(pool.map(x => x.id));
    const out = [];
    for (let i = 0; i < len; i++) {
      const v = Array.isArray(slots) ? slots[i] : null;
      out.push(ids.has(v) ? v : (def[i] || null));
    }
    return out;
  }

  function buildMatches(matchCount, tableCount, teams, pairs) {
    const matches = [];
    for (let m = 0; m < matchCount; m++) {
      const tables = [];
      for (let t = 0; t < tableCount; t++) {
        const tb = emptyTable();
        tb.teamSlots = defaultTeamSlots(teams, t);
        tb.pairSlots = defaultPairSlots(pairs, t);
        tables.push(tb);
      }
      // present: その試合の参加者pid配列。null = 全員参加（後方互換・全モード共通）
      matches.push({ tables, present: null });
    }
    return matches;
  }

  function blankState() {
    const d = CFG.defaults || {};
    const mc = d.matchCount || 3, tc = d.tableCount || 2, mode = d.mode || "solo";
    const teams = buildTeams(tc), pairs = buildPairs(tc);
    return {
      mode,
      matchCount: mc,
      tableCount: tc,
      roster: [],                       // [{id,name,riotId,discordId,discordAvatar}]
      teams,                            // [{id,name}] 4v4（卓数×2）
      pairs,                            // [{id,name}] ダブルアップ（卓数×4）
      matches: buildMatches(mc, tc, teams, pairs),
      updatedAt: Date.now()
    };
  }

  /* ---------- リサイズ（試合数/卓数の増減時にデータ温存）---------- */
  function resizeState(state, matchCount, tableCount) {
    state.teams = buildTeams(tableCount, state.teams);
    state.pairs = buildPairs(tableCount, state.pairs);
    const next = buildMatches(matchCount, tableCount, state.teams, state.pairs);
    for (let m = 0; m < matchCount; m++) {
      const om = state.matches[m];
      for (let t = 0; t < tableCount; t++) {
        const old = om && om.tables[t];
        if (old) {
          if (Array.isArray(old.seats)) next[m].tables[t].seats = old.seats;
          if (old.placements) next[m].tables[t].placements = old.placements;
          if (Array.isArray(old.teamSlots)) next[m].tables[t].teamSlots = normSlots(old.teamSlots, 2, state.teams, defaultTeamSlots(state.teams, t));
          if (Array.isArray(old.pairSlots)) next[m].tables[t].pairSlots = normSlots(old.pairSlots, 4, state.pairs, defaultPairSlots(state.pairs, t));
        }
      }
      if (om) next[m].present = om.present || null;
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

    /* ---- 受信データの形を整える（壊れ防止 + 旧モデルの移行）---- */
    function normalize(data) {
      const s = Object.assign(blankState(), data || {});
      if (!MODES[s.mode]) s.mode = "solo";
      s.matchCount = Math.max(1, s.matchCount | 0 || 1);
      s.tableCount = Math.max(1, s.tableCount | 0 || 1);
      if (!Array.isArray(s.roster)) s.roster = [];

      // 旧モデル（teams/pairs が members を持つ）を検出し、席への引き継ぎ用に保持
      const oldTeams = Array.isArray(s.teams) ? s.teams : [];
      const oldPairs = Array.isArray(s.pairs) ? s.pairs : [];
      const teamHadMembers = oldTeams.some(t => t && Array.isArray(t.members));
      const pairHadMembers = oldPairs.some(p => p && Array.isArray(p.members));

      // プールを {id,name,members} に正規化（ID・名前・既定メンバーを温存）
      s.teams = buildTeams(s.tableCount, oldTeams.map(t => ({ id: t && t.id, name: t && t.name, members: t && t.members })));
      s.pairs = buildPairs(s.tableCount, oldPairs.map(p => ({ id: p && p.id, name: p && p.name, members: p && p.members })));

      if (!Array.isArray(s.matches)) s.matches = buildMatches(s.matchCount, s.tableCount, s.teams, s.pairs);

      for (let m = 0; m < s.matchCount; m++) {
        if (!s.matches[m]) s.matches[m] = { tables: [] };
        if (!Array.isArray(s.matches[m].tables)) s.matches[m].tables = [];
        for (let t = 0; t < s.tableCount; t++) {
          let tb = s.matches[m].tables[t];
          if (!tb) {
            tb = emptyTable();
            tb.teamSlots = defaultTeamSlots(s.teams, t);
            tb.pairSlots = defaultPairSlots(s.pairs, t);
            s.matches[m].tables[t] = tb;
          } else {
            if (!Array.isArray(tb.seats)) tb.seats = new Array(SEATS_PER_TABLE).fill(null);
            while (tb.seats.length < SEATS_PER_TABLE) tb.seats.push(null);
            tb.seats.length = SEATS_PER_TABLE;
            if (!tb.placements || typeof tb.placements !== "object") tb.placements = {};
            tb.teamSlots = normSlots(tb.teamSlots, 2, s.teams, defaultTeamSlots(s.teams, t));
            tb.pairSlots = normSlots(tb.pairSlots, 4, s.pairs, defaultPairSlots(s.pairs, t));
          }
          // 旧モデル移行：席が空なら旧membersから復元（team i→卓floor(i/2)側i%2 / pair i→卓floor(i/4)組i%4）
          if (teamHadMembers && tb.seats.every(x => !x)) {
            const tA = oldTeams[t * 2], tB = oldTeams[t * 2 + 1];
            if (tA && Array.isArray(tA.members)) for (let k = 0; k < 4; k++) tb.seats[k] = tA.members[k] || null;
            if (tB && Array.isArray(tB.members)) for (let k = 0; k < 4; k++) tb.seats[4 + k] = tB.members[k] || null;
          }
          if (pairHadMembers && tb.seats.every(x => !x)) {
            for (let g = 0; g < 4; g++) {
              const pr = oldPairs[t * 4 + g];
              if (pr && Array.isArray(pr.members)) { tb.seats[g * 2] = pr.members[0] || null; tb.seats[g * 2 + 1] = pr.members[1] || null; }
            }
          }
        }
        // 参加者リスト：配列なら現存rosterに絞る、それ以外は null（=全員参加）
        const pr = s.matches[m].present;
        s.matches[m].present = Array.isArray(pr)
          ? pr.filter(id => s.roster.some(p => p.id === id))
          : null;
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
    function newPid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    function setSettings({ matchCount, tableCount, mode: m }) {
      if (m && MODES[m] && m !== state.mode) {
        // モード変更時は席・順位をクリア（解釈が変わるため）／参加者は全員に戻す
        state.mode = m;
        state.matches.forEach(mt => {
          mt.tables.forEach(tb => { tb.seats = new Array(SEATS_PER_TABLE).fill(null); tb.placements = {}; });
          mt.present = null;
        });
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
      const p = { id: newPid(), name, riotId: (riotId || "").trim(), discordId: (discordId || "").trim() };
      state.roster.push(p);
      // 参加者を明示している試合には新規選手も「参加」で追加（null=全員参加はそのまま）
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
      state.matches.forEach(mt => {
        mt.tables.forEach(tb => {
          tb.seats = tb.seats.map(s => (s === id ? null : s));
          delete tb.placements[id];
        });
        if (Array.isArray(mt.present)) mt.present = mt.present.filter(x => x !== id);
      });
      // 既定メンバー（チーム組）からも除去
      (state.teams || []).forEach(t => { if (Array.isArray(t.members)) t.members = t.members.map(m => (m === id ? null : m)); });
      (state.pairs || []).forEach(p => { if (Array.isArray(p.members)) p.members = p.members.map(m => (m === id ? null : m)); });
      save();
    }

    // 席へ配置（全モード共通）。同一試合内の他席からは自動的に外す。
    function assignSeat(matchIdx, tableIdx, seatIdx, playerId) {
      const mt = state.matches[matchIdx];
      const tb = mt.tables[tableIdx];
      if (playerId) {
        // この試合の全卓から一旦外す（重複防止）
        mt.tables.forEach(t => {
          const i = t.seats.indexOf(playerId);
          if (i >= 0) { t.seats[i] = null; delete t.placements[playerId]; }
        });
      }
      // 配置先に別の選手がいたらその順位も破棄
      const evicted = tb.seats[seatIdx];
      if (evicted && evicted !== playerId) delete tb.placements[evicted];
      tb.seats[seatIdx] = playerId;
      // 手動配置したら「参加」扱いに（参加者を明示している試合のみ）
      if (playerId && Array.isArray(mt.present) && !mt.present.includes(playerId)) mt.present.push(playerId);
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

    /* ---- チーム/ペア名（プール・IDで指定）---- */
    function setTeamName(teamId, name) {
      const t = (state.teams || []).find(x => x.id === teamId);
      if (!t) return;
      t.name = (name || "").trim() || t.name;
      save();
    }
    function setPairName(pairId, name) {
      const p = (state.pairs || []).find(x => x.id === pairId);
      if (!p) return;
      p.name = (name || "").trim() || p.name;
      save();
    }

    /* ---- 「チーム組」タブ：既定メンバー（テンプレート）の編集 ----
       同一選手が複数チームの既定に重複しないよう、他チームからは自動で外す。 */
    function setTeamMember(teamId, slot, playerId) {
      const team = (state.teams || []).find(t => t.id === teamId);
      if (!team) return;
      if (!Array.isArray(team.members)) team.members = [null, null, null, null];
      if (playerId) {
        (state.teams || []).forEach(t => { if (Array.isArray(t.members)) { const i = t.members.indexOf(playerId); if (i >= 0) t.members[i] = null; } });
      }
      team.members[slot] = playerId || null;
      save();
    }
    function setPairMember(pairId, slot, playerId) {
      const pair = (state.pairs || []).find(p => p.id === pairId);
      if (!pair) return;
      if (!Array.isArray(pair.members)) pair.members = [null, null];
      if (playerId) {
        (state.pairs || []).forEach(p => { if (Array.isArray(p.members)) { const i = p.members.indexOf(playerId); if (i >= 0) p.members[i] = null; } });
      }
      pair.members[slot] = playerId || null;
      save();
    }

    // 試合mt内の全席からpidを外す（重複防止）。順位も破棄。
    function dedupInMatch(mt, pid) {
      mt.tables.forEach(t => { const i = t.seats.indexOf(pid); if (i >= 0) { t.seats[i] = null; delete t.placements[pid]; } });
    }
    // チームの既定メンバーを、卓tbのサイド(0/1)の席へ流し込む
    function fillSideFromTeam(mt, tb, side, teamId) {
      const team = (state.teams || []).find(t => t.id === teamId);
      const from = side * 4;
      for (let k = 0; k < 4; k++) { const old = tb.seats[from + k]; if (old) delete tb.placements[old]; tb.seats[from + k] = null; }
      if (team && Array.isArray(team.members)) {
        for (let k = 0; k < 4; k++) {
          const pid = team.members[k];
          if (pid) { dedupInMatch(mt, pid); tb.seats[from + k] = pid; if (Array.isArray(mt.present) && !mt.present.includes(pid)) mt.present.push(pid); }
        }
      }
    }
    // ペアの既定メンバーを、卓tbのグループg(0-3)の席へ流し込む
    function fillGroupFromPair(mt, tb, g, pairId) {
      const pair = (state.pairs || []).find(p => p.id === pairId);
      const from = g * 2;
      for (let k = 0; k < 2; k++) { const old = tb.seats[from + k]; if (old) delete tb.placements[old]; tb.seats[from + k] = null; }
      if (pair && Array.isArray(pair.members)) {
        for (let k = 0; k < 2; k++) {
          const pid = pair.members[k];
          if (pid) { dedupInMatch(mt, pid); tb.seats[from + k] = pid; if (Array.isArray(mt.present) && !mt.present.includes(pid)) mt.present.push(pid); }
        }
      }
    }

    /* ---- 対戦カード（この試合の卓の各サイド/グループに座るチーム）----
       チームを選ぶと、そのチームの既定メンバー（チーム組）を席へ引き継ぐ。以後は試合ごとに入替可。 */
    function setMatchTeamSlot(matchIdx, tableIdx, side, teamId) {
      const mt = state.matches[matchIdx];
      const tb = mt && mt.tables[tableIdx];
      if (!tb) return;
      if (!Array.isArray(tb.teamSlots)) tb.teamSlots = [null, null];
      tb.teamSlots[side] = teamId || null;
      fillSideFromTeam(mt, tb, side, teamId);
      save();
    }
    function setMatchPairSlot(matchIdx, tableIdx, group, pairId) {
      const mt = state.matches[matchIdx];
      const tb = mt && mt.tables[tableIdx];
      if (!tb) return;
      if (!Array.isArray(tb.pairSlots)) tb.pairSlots = [null, null, null, null];
      tb.pairSlots[group] = pairId || null;
      fillGroupFromPair(mt, tb, group, pairId);
      save();
    }
    // この試合の全卓に「チーム組」の既定編成を反映（各サイド/グループを、そこに割当たっているチームの既定で埋める）
    function applyRosterToMatch(matchIdx) {
      const mt = state.matches[matchIdx];
      if (!mt) return;
      if (state.mode === "team") {
        mt.tables.forEach(tb => { for (let side = 0; side < 2; side++) fillSideFromTeam(mt, tb, side, (tb.teamSlots || [])[side]); });
      } else if (state.mode === "doubleup") {
        mt.tables.forEach(tb => { for (let g = 0; g < 4; g++) fillGroupFromPair(mt, tb, g, (tb.pairSlots || [])[g]); });
      }
      save();
    }
    // この試合の対戦カードをシャッフル（プールを全スロットへランダム割当）。各枠は既定メンバーを引き継ぐ。
    function shuffleMatchups(matchIdx) {
      const mt = state.matches[matchIdx];
      if (!mt) return;
      if (state.mode === "team") {
        const ids = (state.teams || []).map(t => t.id);
        for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
        let k = 0;
        mt.tables.forEach(tb => { tb.teamSlots = [ids[k++] || null, ids[k++] || null]; });
        mt.tables.forEach(tb => { for (let side = 0; side < 2; side++) fillSideFromTeam(mt, tb, side, tb.teamSlots[side]); });
        save();
      } else if (state.mode === "doubleup") {
        const ids = (state.pairs || []).map(p => p.id);
        for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
        let k = 0;
        mt.tables.forEach(tb => { tb.pairSlots = [ids[k++] || null, ids[k++] || null, ids[k++] || null, ids[k++] || null]; });
        mt.tables.forEach(tb => { for (let g = 0; g < 4; g++) fillGroupFromPair(mt, tb, g, tb.pairSlots[g]); });
        save();
      }
    }

    /* ---- 参加者（出席）管理：全モード。match.present(配列)で保持。null=全員参加 ---- */
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

    /* ---- 自動組卓（全モード）----
       method "random"  : 参加者をシャッフルして配分
       method "points"  : 直前までの累計ptが近い順に配分（高pt帯から卓1へ。同pt帯はランダム）
       solo は卓へ均等配分／team・doubleup は卓を上から8名ずつ詰めて完全な卓を作る。 */
    function autoAssign(matchIdx, method) {
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
        ids.sort((a, b) => (pts[b] - pts[a]) || (Math.random() - 0.5));
      } else {
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
      }

      if (ids.length > cap) { dropped = ids.length - cap; ids = ids.slice(0, cap); }

      mt.tables.forEach(tb => { tb.seats = new Array(SEATS_PER_TABLE).fill(null); tb.placements = {}; });

      const counts = new Array(tableCount).fill(0);
      if (state.mode === "solo") {
        const base = Math.floor(ids.length / tableCount), rem = ids.length % tableCount;
        for (let t = 0; t < tableCount; t++) counts[t] = base + (t < rem ? 1 : 0);
      } else {
        // 卓を上から8名ずつ詰める（4v4・ダブルアップは完全な卓を優先）
        let left = ids.length;
        for (let t = 0; t < tableCount; t++) { counts[t] = Math.min(SEATS_PER_TABLE, left); left -= counts[t]; }
      }

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
      setTeamName, setPairName, setTeamMember, setPairMember,
      setMatchTeamSlot, setMatchPairSlot, applyRosterToMatch, shuffleMatchups,
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
  function teamById(state, id) { return (state.teams || []).find(t => t.id === id) || null; }
  function pairById(state, id) { return (state.pairs || []).find(p => p.id === id) || null; }
  function teamName(state, id) { const t = teamById(state, id); return t ? t.name : "—"; }
  function pairName(state, id) { const p = pairById(state, id); return p ? p.name : "—"; }

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
      const slots = tb.teamSlots || [null, null];
      const sides = [[], []];
      tb.seats.forEach((pid, i) => {
        const side = i < 4 ? 0 : 1;
        if (pid) {
          const rank = tb.placements[pid] || null;
          sides[side].push({ pid, name: nameOf(state, pid), rank, points: pointsFor(mode, rank) });
        }
      });
      const teamData = sides.map((members, side) => ({
        teamId: slots[side] || null,
        name: teamName(state, slots[side]),
        members: members.sort((a, b) => (a.rank || 99) - (b.rank || 99)),
        total: members.reduce((s, x) => s + x.points, 0)
      }));
      teamData.sort((a, b) => b.total - a.total);
      return { mode, teams: teamData };
    }

    // doubleup
    const slots = tb.pairSlots || [null, null, null, null];
    const pairs = [];
    for (let g = 0; g < 4; g++) {
      const a = tb.seats[g * 2], b = tb.seats[g * 2 + 1];
      if (!a && !b) continue;
      const rank = tb.placements[a] || tb.placements[b] || null;
      pairs.push({
        pairId: slots[g] || null,
        name: pairName(state, slots[g]),
        members: [a, b].filter(Boolean).map(pid => ({ pid, name: nameOf(state, pid) })),
        rank, points: pointsFor(mode, rank)
      });
    }
    pairs.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    return { mode, pairs };
  }

  // 全体順位（個人の累計pt）
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
    const all = Object.values(totals);
    const list = (rows.length ? rows : all);
    list.sort((a, b) => b.points - a.points || b.games - a.games || a.name.localeCompare(b.name, "ja"));
    return list;
  }

  // チーム戦：チームIDで全試合を通算。各試合の各卓で teamSlots に自分がいるサイドの席の合計pt。
  function teamOverall(state) {
    const teams = state.teams || [];
    const tot = teams.map(team => {
      let points = 0, games = 0; const memberSet = {};
      state.matches.forEach(mt => mt.tables.forEach(tb => {
        const side = (tb.teamSlots || []).indexOf(team.id);
        if (side < 0) return;
        const from = side * 4, to = from + 4;
        let seated = false;
        for (let i = from; i < to; i++) {
          const pid = tb.seats[i];
          if (!pid) continue;
          seated = true; memberSet[pid] = true;
          const rank = tb.placements[pid];
          if (rank) points += pointsFor("team", rank);
        }
        if (seated) games += 1;
      }));
      return {
        teamId: team.id, name: team.name, points, games,
        members: Object.keys(memberSet).map(pid => ({ pid, name: nameOf(state, pid), avatar: avatarOf(state, pid) }))
      };
    });
    return tot.filter(t => t.members.length || t.points).sort((a, b) => b.points - a.points || b.games - a.games);
  }

  // ダブルアップ：チーム(ペア)IDで全試合を通算。各卓で pairSlots に自分がいるグループの席の合計pt。
  function pairOverall(state) {
    const pairs = state.pairs || [];
    const tot = pairs.map(pair => {
      let points = 0, games = 0; const memberSet = {};
      state.matches.forEach(mt => mt.tables.forEach(tb => {
        const g = (tb.pairSlots || []).indexOf(pair.id);
        if (g < 0) return;
        const a = tb.seats[g * 2], b = tb.seats[g * 2 + 1];
        if (a) memberSet[a] = true;
        if (b) memberSet[b] = true;
        if (a || b) {
          games += 1;
          const rank = (a && tb.placements[a]) || (b && tb.placements[b]) || null;
          if (rank) points += pointsFor("doubleup", rank);
        }
      }));
      return {
        pairId: pair.id, name: pair.name, points, games,
        members: Object.keys(memberSet).map(pid => ({ pid, name: nameOf(state, pid), avatar: avatarOf(state, pid) }))
      };
    });
    return tot.filter(t => t.members.length || t.points).sort((a, b) => b.points - a.points || b.games - a.games);
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
       戻り値: { matchId, placements: {pid: rank}, doubleup } or null */
    async autoDetectTable(playersWithRiot, onProgress) {
      const valid = playersWithRiot.filter(p => p.riotId && p.riotId.includes("#"));
      if (valid.length < 2) throw new Error("Riot ID登録済みの選手が2人以上必要です");

      const puuids = {};
      for (const p of valid) {
        onProgress && onProgress("PUUID取得中: " + p.riotId);
        puuids[p.pid] = await Riot.puuid(p.riotId);
      }

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
        const allIn = [...targetPuuids].every(pu => partPuuids.has(pu));
        if (!allIn) continue;

        const placements = {};
        const isDouble = (detail.info && detail.info.tft_game_type === "pairs") ||
          parts.some(p => p.partner_group_id != null);

        for (const p of valid) {
          const pu = puuids[p.pid];
          const part = parts.find(x => x.puuid === pu);
          if (!part) continue;
          if (isDouble) {
            placements[p.pid] = Math.ceil((part.placement || 8) / 2);
          } else {
            placements[p.pid] = part.placement;
          }
        }
        return { matchId, placements, doubleup: isDouble };
      }
      return null;
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
      return res.json();
    }
  };

  /* ---------- 公開 ---------- */
  window.TFTCore = {
    SEATS_PER_TABLE, MODES,
    pointsFor, makeStore,
    playerById, nameOf, avatarOf, teamById, pairById, teamName, pairName,
    isPresent, presentList,
    tableStandings, overallStandings, teamOverall, pairOverall,
    Riot, Discord
  };
})();
