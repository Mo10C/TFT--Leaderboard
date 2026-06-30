/* =============================================================
   worker.js  —  Cloudflare Worker (Riot API 中継プロキシ)
   役割: APIキーを秘匿し、ブラウザのCORS制限を回避する。
   デプロイ後に出る URL を config.js の workerUrl に貼ってください。

   必要なシークレット（環境変数）:
     RIOT_API_KEY = あなたのRiot APIキー（RGAPI-... ）
     ※ Cloudflare ダッシュボード → Worker → Settings → Variables → Secret
       または: npx wrangler secret put RIOT_API_KEY

   エンドポイント:
     GET /account?gameName=Mo10C&tagLine=JP1&region=asia
     GET /matches?puuid=...&count=20&region=asia
     GET /match?matchId=...&region=asia
   ============================================================= */

const ALLOWED_REGIONS = ["asia", "americas", "europe"];

// 必要ならここを自分のGitHub Pages originに絞るとより安全
//   例: "https://mo10c.github.io"
const ALLOW_ORIGIN = "*";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    if (!env.RIOT_API_KEY) {
      return json({ error: "RIOT_API_KEY 未設定（Workerのシークレットを設定してください）" }, 500);
    }

    const region = pick(url.searchParams.get("region"), ALLOWED_REGIONS, "asia");
    const base = `https://${region}.api.riotgames.com`;

    try {
      let riotUrl;

      switch (url.pathname.replace(/\/$/, "")) {
        case "/account": {
          const gameName = url.searchParams.get("gameName");
          const tagLine = url.searchParams.get("tagLine");
          if (!gameName || !tagLine) return json({ error: "gameName と tagLine が必要です" }, 400);
          riotUrl = `${base}/riot/account/v1/accounts/by-riot-id/${enc(gameName)}/${enc(tagLine)}`;
          break;
        }
        case "/matches": {
          const puuid = url.searchParams.get("puuid");
          const count = Math.min(parseInt(url.searchParams.get("count") || "20", 10), 50);
          if (!puuid) return json({ error: "puuid が必要です" }, 400);
          riotUrl = `${base}/tft/match/v1/matches/by-puuid/${enc(puuid)}/ids?count=${count}`;
          break;
        }
        case "/match": {
          const matchId = url.searchParams.get("matchId");
          if (!matchId) return json({ error: "matchId が必要です" }, 400);
          riotUrl = `${base}/tft/match/v1/matches/${enc(matchId)}`;
          break;
        }
        default:
          return json({ error: "unknown endpoint" }, 404);
      }

      const r = await fetch(riotUrl, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { ...cors(), "Content-Type": "application/json" }
      });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }
};

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
