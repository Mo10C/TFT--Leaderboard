/* =============================================================
   worker.js  —  Cloudflare Worker (Riot API 中継 + Discordアバター解決)
   役割: APIキー/トークンを秘匿し、ブラウザのCORS制限を回避する。
   デプロイ後に出る URL を config.js の workerUrl に貼ってください。

   必要なシークレット/環境変数:
     RIOT_API_KEY        = Riot APIキー（RGAPI-...）           ※Riot系で必須
     DISCORD_BOT_TOKEN   = Discord Bot トークン                ※/avatar で必須
     DISCORD_GUILD_ID    = （任意）サーバーID。設定するとサーバー専用アバターを優先
   ※ Cloudflare: Worker → Settings → Variables and Secrets → Add → Secret
     または: npx wrangler secret put RIOT_API_KEY  /  DISCORD_BOT_TOKEN

   エンドポイント:
     GET /account?gameName=Mo10C&tagLine=819&region=asia
     GET /matches?puuid=...&count=20&region=asia
     GET /match?matchId=...&region=asia
     GET /avatar?userId=<DiscordユーザーID>
   ============================================================= */

const ALLOWED_REGIONS = ["asia", "americas", "europe"];
const DISCORD_API = "https://discord.com/api/v10";

// 必要ならここを自分のGitHub Pages originに絞るとより安全（例: "https://mo10c.github.io"）
const ALLOW_ORIGIN = "*";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    const path = url.pathname.replace(/\/$/, "");

    try {
      // ルート確認用
      if (path === "" || path === "/") {
        return new Response("MCC TFT riot proxy is running.", {
          headers: { ...cors(), "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      // ---- Discord アバター解決（Riotキー不要・botトークンが必要）----
      if (path === "/avatar") {
        const userId = url.searchParams.get("userId");
        if (!userId) return json({ error: "userId が必要です" }, 400);
        return await handleAvatar(userId, env);
      }

      // ---- ここから Riot 系（RIOT_API_KEY が必要）----
      if (["/account", "/matches", "/match"].includes(path)) {
        if (!env.RIOT_API_KEY) return json({ error: "RIOT_API_KEY 未設定（Workerのシークレットを設定してください）" }, 500);
        const region = pick(url.searchParams.get("region"), ALLOWED_REGIONS, "asia");
        const base = `https://${region}.api.riotgames.com`;
        let riotUrl;

        if (path === "/account") {
          const gameName = url.searchParams.get("gameName");
          const tagLine = url.searchParams.get("tagLine");
          if (!gameName || !tagLine) return json({ error: "gameName と tagLine が必要です" }, 400);
          riotUrl = `${base}/riot/account/v1/accounts/by-riot-id/${enc(gameName)}/${enc(tagLine)}`;
        } else if (path === "/matches") {
          const puuid = url.searchParams.get("puuid");
          const count = Math.min(parseInt(url.searchParams.get("count") || "20", 10), 50);
          if (!puuid) return json({ error: "puuid が必要です" }, 400);
          riotUrl = `${base}/tft/match/v1/matches/by-puuid/${enc(puuid)}/ids?count=${count}`;
        } else {
          const matchId = url.searchParams.get("matchId");
          if (!matchId) return json({ error: "matchId が必要です" }, 400);
          riotUrl = `${base}/tft/match/v1/matches/${enc(matchId)}`;
        }

        const r = await fetch(riotUrl, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
        const body = await r.text();
        return new Response(body, { status: r.status, headers: { ...cors(), "Content-Type": "application/json" } });
      }

      return json({ error: "unknown endpoint" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }
};

/* ---------- Discord アバター ---------- */
async function handleAvatar(userId, env) {
  if (!env.DISCORD_BOT_TOKEN) return json({ error: "DISCORD_BOT_TOKEN 未設定（Workerのシークレットを設定してください）" }, 500);
  const auth = { Authorization: "Bot " + env.DISCORD_BOT_TOKEN };

  let user = null;
  let guildAvatar = null;

  // サーバー専用アバターを優先（GUILD_ID があり、botがそのサーバーにいる場合）
  if (env.DISCORD_GUILD_ID) {
    try {
      const mr = await fetch(`${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}/members/${userId}`, { headers: auth });
      if (mr.ok) {
        const m = await mr.json();
        user = m.user || null;
        if (m.avatar) guildAvatar = m.avatar;
      }
    } catch (e) { /* フォールバックへ */ }
  }

  // グローバルのユーザー情報（botがサーバーにいなくても取得可）
  if (!user) {
    const ur = await fetch(`${DISCORD_API}/users/${userId}`, { headers: auth });
    if (ur.status === 404) return json({ error: "discord 404 user not found" }, 404);
    if (ur.status === 401) return json({ error: "discord 401 botトークンが不正です" }, 502);
    if (!ur.ok) {
      const t = await ur.text().catch(() => "");
      return json({ error: "discord " + ur.status + " " + t.slice(0, 120) }, 502);
    }
    user = await ur.json();
  }

  return json({
    id: userId,
    username: user.global_name || user.username || "",
    avatarUrl: buildAvatarUrl(userId, user, guildAvatar, env.DISCORD_GUILD_ID)
  });
}

function buildAvatarUrl(userId, user, guildAvatar, guildId) {
  const base = "https://cdn.discordapp.com";
  if (guildAvatar && guildId) {
    const ext = String(guildAvatar).startsWith("a_") ? "gif" : "png";
    return `${base}/guilds/${guildId}/users/${userId}/avatars/${guildAvatar}.${ext}?size=64`;
  }
  if (user && user.avatar) {
    const ext = String(user.avatar).startsWith("a_") ? "gif" : "png";
    return `${base}/avatars/${userId}/${user.avatar}.${ext}?size=64`;
  }
  // 未設定 → デフォルトアバター
  let idx = 0;
  try { idx = Number((BigInt(userId) >> 22n) % 6n); } catch (e) { idx = 0; }
  return `${base}/embed/avatars/${idx}.png`;
}

/* ---------- util ---------- */
function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors(), "Content-Type": "application/json" }
  });
}
function enc(s) { return encodeURIComponent(s); }
function pick(v, allowed, fallback) { return allowed.includes(v) ? v : fallback; }
