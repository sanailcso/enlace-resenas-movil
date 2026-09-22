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

type Source = "place-id" | "maps-url" | "short-code" | "name";

type ReviewCandidate = {
  placeId: string;
  reviewUrl: string;
  name: string;
  address?: string;
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

function findPlaceId(value: unknown): string | null {
  if (typeof value === "string") return value.match(PLACE_ID_RE)?.[1] ?? null;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const placeId = findPlaceId(item);
    if (placeId) return placeId;
  }
  return null;
}

function collectCandidates(value: unknown, results: ReviewCandidate[] = []) {
  if (!Array.isArray(value)) return results;

  const hexPair = typeof value[10] === "string" ? value[10].match(HEX_PAIR_RE) : null;
  const name = typeof value[11] === "string" ? value[11].trim() : "";
  if (hexPair && name) {
    const placeId = findPlaceId(value) ?? placeIdFromHexPair(hexPair[1], hexPair[2]);
    const addressParts = Array.isArray(value[2])
      ? value[2].filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
      : [];
    const address = addressParts.join(", ");

    if (!results.some((candidate) => candidate.placeId === placeId)) {
      results.push({
        placeId,
        reviewUrl: REVIEW_PREFIX + placeId,
        name,
        ...(address ? { address } : {}),
      });
    }
  }

  for (const item of value) collectCandidates(item, results);
  return results;
}

function parseMapCandidates(text: string) {
  const trimmed = text.replace(/^\)\]\}'\s*/, "");
  try {
    return collectCandidates(JSON.parse(trimmed)).slice(0, 8);
  } catch {
    return [];
  }
}

function nameFromMapsUrl(url: URL) {
  const match = decodeText(url.pathname).match(/\/place\/([^/]+)/i);
  if (!match) return null;
  const name = match[1].replace(/\+/g, " ").trim();
  return name && !/^0x[\da-f]+:/i.test(name) ? name : null;
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

async function inspectCandidate(start: string, fallbackName?: string) {
  let current = safeUrl(start);
  const observed: string[] = [];
  let discoveredName = nameFromMapsUrl(current);

  for (let hop = 0; hop <= 10; hop += 1) {
    observed.push(current.href);
    discoveredName ||= nameFromMapsUrl(current);
    const fromUrl = extractPlaceId(current.href);
    if (fromUrl && discoveredName) {
      return [{ placeId: fromUrl, reviewUrl: REVIEW_PREFIX + fromUrl, name: discoveredName }];
    }

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
    const parsed = parseMapCandidates(body);
    if (parsed.length) return parsed;

    const mapDataLink = body.match(/href="([^"]*tbm=map[^"]*)"/i)?.[1];
    if (mapDataLink) {
      try {
        const mapDataUrl = safeUrl(new URL(mapDataLink.replace(/&amp;/g, "&"), current).href);
        const mapDataResponse = await fetch(mapDataUrl.href, { headers: GOOGLE_HEADERS });
        const mapDataBody = await mapDataResponse.text();
        const mapCandidates = parseMapCandidates(mapDataBody);
        if (mapCandidates.length) return mapCandidates;
        const fromMapData = extractPlaceId(mapDataBody);
        if (fromMapData) {
          return [{
            placeId: fromMapData,
            reviewUrl: REVIEW_PREFIX + fromMapData,
            name: discoveredName ?? fallbackName ?? "Empresa de Google Maps",
          }];
        }
      } catch {
        // Continúa con el mensaje de ayuda si Google no ofrece datos de mapa.
      }
    }

    const fromBody = extractPlaceId(body);
    if (fromBody) {
      return [{
        placeId: fromBody,
        reviewUrl: REVIEW_PREFIX + fromBody,
        name: discoveredName ?? fallbackName ?? "Empresa de Google Maps",
      }];
    }
    break;
  }

  const placeId = extractPlaceId(observed.join("\n"));
  return placeId
    ? [{ placeId, reviewUrl: REVIEW_PREFIX + placeId, name: discoveredName ?? fallbackName ?? "Empresa de Google Maps" }]
    : [];
}

async function searchNameCandidates(query: string) {
  const searchUrl = safeUrl(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`);
  try {
    const response = await fetch(searchUrl.href, { headers: GOOGLE_HEADERS });
    const body = await response.text();
    const directCandidates = parseMapCandidates(body);
    if (directCandidates.length) return directCandidates;

    const mapDataLink = body.match(/href="([^"]*tbm=map[^"]*)"/i)?.[1];
    if (!mapDataLink) return [];
    const mapDataUrl = safeUrl(new URL(mapDataLink.replace(/&amp;/g, "&"), response.url).href);
    const mapDataResponse = await fetch(mapDataUrl.href, { headers: GOOGLE_HEADERS });
    return parseMapCandidates(await mapDataResponse.text());
  } catch {
    return [];
  }
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
    candidates: [`https://www.google.com/maps/search/?api=1&query=${query}`, `https://www.google.com/maps?q=${query}`],
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
  if (direct) {
    const matches = await inspectCandidate(
      `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(direct)}`,
      "Empresa de Google Maps",
    );
    const candidates = matches.length
      ? matches
      : [{ placeId: direct, reviewUrl: REVIEW_PREFIX + direct, name: "Empresa de Google Maps" }];
    return json({ source: "place-id" satisfies Source, candidates });
  }

  try {
    const { source, candidates } = classifyInput(input);
    if (source === "name") {
      const matches = await searchNameCandidates(input);
      if (matches.length) return json({ source, candidates: matches });
    }
    for (const candidate of candidates) {
      const matches = await inspectCandidate(candidate, source === "name" ? input : undefined);
      if (matches.length) return json({ source, candidates: matches });
    }

    const error = source === "short-code"
      ? "Ese código corto no existe, ha caducado o está incompleto. Pega el enlace completo de Compartir."
      : "No pude identificar la ficha. Abre la empresa en Google Maps y pega el enlace de Compartir.";
    return json({ error }, 422);
  } catch (reason) {
    return json({ error: reason instanceof Error ? reason.message : "No se pudo procesar el enlace." }, 400);
  }
}
