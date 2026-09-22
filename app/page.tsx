"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Check, Clipboard, Link2, LoaderCircle, MapPin, Nfc, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ReviewResult = {
  placeId: string;
  reviewUrl: string;
  name: string;
  address?: string;
};

type ResolveResponse = {
  source: "place-id" | "maps-url" | "short-code" | "name";
  candidates: ReviewResult[];
  error?: string;
};

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  fallback.select();
  document.execCommand("copy");
  fallback.remove();
}

export default function Home() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [candidates, setCandidates] = useState<ReviewResult[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCopied = useCallback(() => {
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2800);
  }, []);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const generate = useCallback(async (rawInput: string) => {
    const value = rawInput.trim();
    if (!value) {
      setError("Pega un enlace de Google Maps o escribe una empresa y su ciudad.");
      return null;
    }

    setLoading(true);
    setError("");
    setResult(null);
    setCandidates([]);
    setCopied(false);

    try {
      const response = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: value }),
      });
      const payload = await response.json() as ResolveResponse;
      if (!response.ok) throw new Error(payload.error || "No se pudo crear el enlace.");

      if (!payload.candidates?.length) throw new Error("Google no devolvió ninguna empresa.");
      if (payload.candidates.length > 1) {
        setCandidates(payload.candidates);
        return null;
      }

      const nextResult = payload.candidates[0];
      setResult(nextResult);
      try {
        await copyText(nextResult.reviewUrl);
        showCopied();
      } catch {
        // El botón de copia permanece disponible si el navegador bloquea la copia automática.
      }
      return nextResult;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo crear el enlace.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [showCopied]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await generate(input);
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await copyText(result.reviewUrl);
      showCopied();
    } catch {
      setError("Tu navegador no permitió copiar. Mantén pulsado el enlace para copiarlo.");
    }
  }

  async function selectCandidate(candidate: ReviewResult) {
    setResult(candidate);
    setCandidates([]);
    setError("");
    try {
      await copyText(candidate.reviewUrl);
      showCopied();
    } catch {
      setError("Tu navegador no permitió copiar. Mantén pulsado el enlace para copiarlo.");
    }
  }

  useEffect(() => {
    const context = (document as Document & {
      modelContext?: {
        registerTool?: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void>;
      };
    }).modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: "generate_review_link",
      title: "Generar enlace de reseña",
      description: "Convierte un nombre, enlace de Google Maps o Place ID en un enlace directo para escribir una reseña y lo muestra en la página.",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Nombre y ciudad, enlace de Google Maps o Place ID." },
        },
        required: ["input"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async (toolInput: unknown) => {
        const value = typeof toolInput === "object" && toolInput !== null && "input" in toolInput
          ? String((toolInput as { input: unknown }).input)
          : "";
        setInput(value);
        const generated = await generate(value);
        if (!generated) return { candidates: "La página muestra las empresas encontradas para que el usuario elija la correcta." };
        return generated;
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);

    return () => lifecycle.abort();
  }, [generate]);

  return (
    <main className="min-h-svh overflow-hidden bg-background text-foreground">
      <div aria-hidden="true" className="fixed inset-0 overflow-hidden">
        <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute -bottom-40 -left-28 h-96 w-96 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="grid-glow absolute inset-0 opacity-35" />
      </div>

      <section className="relative mx-auto flex min-h-svh w-full max-w-xl flex-col px-5 pb-8 pt-6 sm:px-8 sm:pt-10">
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl border border-primary/30 bg-primary/10 shadow-[0_0_32px_rgb(163_230_53/12%)]">
              <Nfc className="h-6 w-6 text-primary" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold tracking-wide text-white">Reseña directa</p>
              <p className="text-xs text-zinc-500">Preparado para NFC</p>
            </div>
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-400">Móvil</span>
        </header>

        <div className="mb-7">
          <p className="mb-3 flex items-center gap-2 text-sm font-medium text-primary">
            <Sparkles className="h-4 w-4" aria-hidden="true" /> Enlace listo en segundos
          </p>
          <h1 className="max-w-md text-[clamp(2.15rem,9vw,3.7rem)] font-semibold leading-[0.98] tracking-[-0.055em] text-white">
            De Google Maps a tu tarjeta NFC.
          </h1>
        </div>

        <div className="rounded-[28px] border border-white/10 bg-card/90 p-4 shadow-[0_24px_80px_rgb(0_0_0/35%)] backdrop-blur-xl sm:p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="business-input" className="mb-2 block text-sm font-medium text-zinc-200">Empresa o enlace de Google Maps</label>
              <Textarea
                id="business-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Pega aquí el enlace de Compartir…"
                rows={4}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="min-h-28 resize-none rounded-2xl border-white/10 bg-black/25 px-4 py-3.5 text-base leading-relaxed text-white placeholder:text-zinc-600 focus-visible:border-primary/55 focus-visible:ring-primary/20"
              />
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">También admite Place ID, código corto o nombre completo con ciudad.</p>
            </div>

            <Button type="submit" disabled={loading || !input.trim()} className="h-14 w-full rounded-2xl bg-primary text-base font-bold text-primary-foreground shadow-[0_12px_32px_rgb(163_230_53/16%)] transition-transform active:scale-[0.98] hover:bg-primary/90">
              {loading ? <><LoaderCircle className="mr-2 h-5 w-5 animate-spin" /> Buscando ficha…</> : <><Link2 className="mr-2 h-5 w-5" /> Crear y copiar enlace</>}
            </Button>
          </form>

          <div aria-live="polite" aria-atomic="true">
            {error && <div className="mt-4 rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm leading-relaxed text-red-200">{error}</div>}
            {candidates.length > 1 && (
              <div className="mt-5 border-t border-white/10 pt-5">
                <div className="mb-3">
                  <p className="text-sm font-semibold text-white">Elige la empresa correcta</p>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">Google encontró varias coincidencias. Comprueba el nombre y la dirección antes de copiar.</p>
                </div>
                <div className="max-h-[25rem] space-y-2 overflow-y-auto pr-1">
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.placeId}
                      type="button"
                      onClick={() => void selectCandidate(candidate)}
                      className="group w-full rounded-2xl border border-white/10 bg-black/25 p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <span className="block text-sm font-semibold leading-snug text-white group-hover:text-primary">{candidate.name}</span>
                      {candidate.address && (
                        <span className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-zinc-500">
                          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {candidate.address}
                        </span>
                      )}
                      <span className="mt-3 block text-xs font-semibold text-primary">Elegir y copiar enlace</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {result && (
              <div className="mt-5 border-t border-white/10 pt-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="flex items-center gap-2 text-sm font-semibold text-white">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-primary"><Check className="h-4 w-4" /></span>
                    Enlace preparado
                  </p>
                  {copied && <span className="text-xs font-semibold text-primary">Copiado</span>}
                </div>
                <div className="mb-3 rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3">
                  <p className="text-base font-semibold leading-snug text-white">{result.name}</p>
                  {result.address && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-zinc-400">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                      {result.address}
                    </p>
                  )}
                </div>
                <button type="button" onClick={handleCopy} className="group flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-black/25 p-3.5 text-left transition-colors hover:border-primary/35">
                  <span className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-zinc-300">{result.reviewUrl}</span>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/7 text-zinc-300 group-hover:text-primary">
                    {copied ? <Check className="h-5 w-5" /> : <Clipboard className="h-5 w-5" />}
                  </span>
                </button>
                <p className="mt-3 text-xs text-zinc-500">Pégalo en NFC Tools como registro URL/URI.</p>
              </div>
            )}
          </div>
        </div>

        <footer className="mt-auto pt-7 text-center text-xs leading-relaxed text-zinc-600">
          Para empresas con nombres parecidos, usa siempre el enlace de <strong className="font-medium text-zinc-400">Compartir</strong> de la ficha correcta.
        </footer>
      </section>
    </main>
  );
}
