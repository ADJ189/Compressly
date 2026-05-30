// FFmpeg.wasm singleton — loaded once per session, reused for all compressions.
// Uses multithreaded core when SharedArrayBuffer is available (requires COOP/COEP headers).

const FFMPEG_PKG  = 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10';
const FFMPEG_UTIL = 'https://esm.sh/@ffmpeg/util@0.12.2';
const CORE_MT     = 'https://esm.sh/@ffmpeg/core-mt@0.12.6/dist/esm';
const CORE_ST     = 'https://esm.sh/@ffmpeg/core@0.12.6/dist/esm';

let _instance: unknown = null;
let _loading:  Promise<unknown> | null = null;

export async function getFFmpeg(): Promise<unknown> {
  if (_instance) return _instance;
  if (_loading)  return _loading;

  _loading = (async () => {
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import(/* @vite-ignore */ FFMPEG_PKG),
      import(/* @vite-ignore */ FFMPEG_UTIL),
    ]);

    const ff   = new FFmpeg();
    const hasMT = typeof SharedArrayBuffer !== 'undefined';
    const base  = hasMT ? CORE_MT : CORE_ST;

    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      ...(hasMT ? { workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript') } : {}),
    });

    _instance = ff;
    _loading  = null;
    return ff;
  })();

  return _loading;
}

export async function ffFetch(file: File | string): Promise<Uint8Array> {
  const { fetchFile } = await import(/* @vite-ignore */ FFMPEG_UTIL);
  return fetchFile(file);
}

export function ffHasMT(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}
