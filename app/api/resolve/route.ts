const REVIEW_PREFIX = "https://search.google.com/local/writereview?placeid=";
const PLACE_ID_RE = /\b(ChI[A-Za-z0-9_-]{10,})\b/;
const HEX_PAIR_RE = /(0x[0-9a-fA-F]+):(0x[0-9a-fA-F]+)/;
const SHORT_CODE_RE = /^[A-Za-z0-9_-]{8,30}$/;
const MAX_INPUT = 2_000;
const GOOGLE_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.6",
  "Cookie": "CONSENT=YES+",
};

export const runtime = "edge";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function littleEndian(value: bigint) {
  const bytes = new Uint8Array(8);
  for (let index = 0; index < 8; index += 1) bytes[index] = Number((value >> BigInt(index * 8)) & 0xffn);
  return bytes;
}

function placeIdFromHexPair(first: string, second: string) {
  const payload = new Uint8Array(20);
  payload.set([0x0a, 0x12, 0x09], 0);
  payload.set(littleEndian(BigInt(first)), 3);
  payload.set([0x11], 11);
  payload.set(littleEndian(BigInt(second)), 12);
  let binary = "";
  payload.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeText(text: string) {
  let decoded = text.replace(/&amp;/g, "&").replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\u002f/g, "/");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { decoded = decodeURIComponent(decoded); } catch { break; }
  }
  return decoded;
}

function extractPlaceId(text: string) {
  const decoded = decodeText(text);
  const direct = decoded.match(PLACE_ID_RE);
  if (direct) return direct[1];
  const pair = decoded.match(HEX_PAIR_RE);
  return pair ? placeIdFromHexPair(pair[1], pair[2]) : null;
}

function isAllowedGoogleHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === "google.com" || host.endsWith(".google.com") || host === "goo.gl" || host.endsWith(".goo.gl") || host === "g.page";
}

function safeUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !isAllowedGoogleHost(url.hostname)) throw new Error("Solo se admiten enlaces HTTPS de Google Maps.");
  return url;
}

async function inspectCandidate(start: string) {
  let current = safeUrl(start);
  const observed: string[] = [];

  for (let hop = 0; hop <= 10; hop += 1) {
    observed.push(current.href);
    const fromUrl = extractPlaceId(current.href);
    if (fromUrl) return fromUrl;

    if (current.hostname === "consent.google.com") {
      const continuation = current.searchParams.get("continue");
      if (continuation) {
        current = safeUrl(continuation);
        continue;
      }
    }

    let response: Response;
    try {
      response = await fetch(current.href, {
        redirect: "manual",
        headers: GOOGLE_HEADERS,
      });
    } catch {
      return null;
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = safeUrl(new URL(location, current).href);
      continue;
    }

    const body = await response.text();
    const fromBody = extractPlaceId(body);
    if (fromBody) return fromBody;

    const mapDataLink = body.match(/href="([^"]*tbm=map[^"]*)"/i)?.[1];
    if (mapDataLink) {
      try {
        const mapDataUrl = safeUrl(new URL(mapDataLink.replace(/&amp;/g, "&"), current).href);
        const mapDataResponse = await fetch(mapDataUrl.href, { headers: GOOGLE_HEADERS });
        const fromMapData = extractPlaceId(await mapDataResponse.text());
        if (fromMapData) return fromMapData;
      } catch {
        // Continúa con el mensaje de ayuda si Google no ofrece datos de mapa.
      }
    }
    break;
  }

  return extractPlaceId(observed.join("\n"));
}

function classifyInput(value: string) {
  if (/^https?:\/\//i.test(value)) return { source: "maps-url" as const, candidates: [safeUrl(value).href] };
  if (SHORT_CODE_RE.test(value)) {
    return {
      source: "short-code" as const,
      candidates: [`https://maps.app.goo.gl/${value}`, `https://goo.gl/maps/${value}`, `https://g.page/r/${value}/review`],
    };
  }
  const query = encodeURIComponent(value);
  return {
    source: "name" as const,
    candidates: [`https://www.google.com/maps/search/?api=1&ucbcb=1&query=${query}`, `https://www.google.com/maps?ucbcb=1&q=${query}`],
  };
}

export async function POST(request: Request) {
  let input = "";
  try {
    const body = await request.json() as { input?: unknown };
    input = typeof body.input === "string" ? body.input.trim() : "";
  } catch {
    return json({ error: "La petición no es válida." }, 400);
  }

  if (!input) return json({ error: "Pega un enlace o escribe una empresa." }, 400);
  if (input.length > MAX_INPUT) return json({ error: "La entrada es demasiado larga." }, 400);

  const direct = extractPlaceId(input);
  if (direct) return json({ placeId: direct, reviewUrl: REVIEW_PREFIX + direct, source: "place-id" });

  try {
    const { source, candidates } = classifyInput(input);
    for (const candidate of candidates) {
      const placeId = await inspectCandidate(candidate);
      if (placeId) return json({ placeId, reviewUrl: REVIEW_PREFIX + placeId, source });
    }

    const error = source === "short-code"
      ? "Ese código corto no existe, ha caducado o está incompleto. Pega el enlace completo de Compartir."
      : "No pude identificar la ficha. Abre la empresa en Google Maps y pega el enlace de Compartir.";
    return json({ error }, 422);
  } catch (reason) {
    return json({ error: reason instanceof Error ? reason.message : "No se pudo procesar el enlace." }, 400);
  }
}
