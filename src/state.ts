export interface State {
  read(job: string): Promise<{ watermark: number | null; generation: string; counts?: Record<string, number> }>;
  /** Compare-and-set on the object generation. false = another run advanced the watermark first. */
  write(job: string, watermark: number, generation: string, counts?: Record<string, number>): Promise<boolean>;
}

const META = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
type F = (url: string, init?: RequestInit) => Promise<Response>;

/** Watermark per job in one GCS object, via the JSON API and the metadata-server token (no SDK). */
export function createGcsState(fetchFn: F, bucket: string, timeoutMs = 10_000): State {
  const call: F = (url, init) => fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  const auth = async () => {
    const r = await call(META, { headers: { "Metadata-Flavor": "Google" } });
    if (!r.ok) throw new Error(`metadata token failed: HTTP ${r.status}`);
    return { Authorization: `Bearer ${((await r.json()) as { access_token: string }).access_token}` };
  };
  const name = (job: string) => encodeURIComponent(`watermark-${job}.json`);
  const b = encodeURIComponent(bucket);
  return {
    async read(job) {
      const r = await call(`https://storage.googleapis.com/storage/v1/b/${b}/o/${name(job)}?alt=media`, { headers: await auth() });
      if (r.status === 404) return { watermark: null, generation: "0" };
      if (!r.ok) throw new Error(`state read failed: HTTP ${r.status}`);
      const j = (await r.json()) as { watermark?: number; counts?: Record<string, number> };
      const w = Number(j.watermark);
      return { watermark: Number.isFinite(w) ? w : null, generation: r.headers.get("x-goog-generation") ?? "0", counts: j.counts && typeof j.counts === "object" ? j.counts : undefined };
    },
    async write(job, watermark, generation, counts) {
      const r = await call(`https://storage.googleapis.com/upload/storage/v1/b/${b}/o?uploadType=media&name=${name(job)}&ifGenerationMatch=${encodeURIComponent(generation)}`, {
        method: "POST", headers: { ...(await auth()), "Content-Type": "application/json" }, body: JSON.stringify({ watermark, counts }),
      });
      if (r.status === 412) return false;
      if (!r.ok) throw new Error(`state write failed: HTTP ${r.status}`);
      return true;
    },
  };
}
