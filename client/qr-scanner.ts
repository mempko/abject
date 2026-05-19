/**
 * In-page QR scanner. Prefers the native BarcodeDetector API (Chrome, Edge,
 * mobile Chrome — much faster and more reliable on dense QRs) and falls back
 * to jsqr for browsers without it (Firefox, Safari). Requests a high-res
 * rear camera stream so dense pairing QRs are readable.
 *
 * Calls onResult(text) when a QR is decoded — for our pairing flow this is
 * a `?pair=…` URL. Throws on permission denial or no camera available.
 */

export interface QrScannerHandle {
  stop(): void;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

export async function startQrScanner(opts: {
  video: HTMLVideoElement;
  onResult: (text: string) => void;
  onError?: (err: Error) => void;
}): Promise<QrScannerHandle> {
  // Request a high-res rear camera. Dense pairing QRs need real pixels.
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    opts.onError?.(e);
    throw e;
  }

  opts.video.srcObject = stream;
  opts.video.setAttribute('playsinline', 'true');
  opts.video.muted = true;
  await opts.video.play().catch(() => { /* user interaction may be required */ });

  // Build a detector: native BarcodeDetector if supported, else jsqr fallback.
  const detector = await buildDetector();

  let stopped = false;
  let rafId = 0;
  let busy = false;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Could not get 2D canvas context');
  }

  const tick = async () => {
    if (stopped) return;
    if (busy) {
      rafId = requestAnimationFrame(() => { void tick(); });
      return;
    }
    if (opts.video.readyState !== opts.video.HAVE_ENOUGH_DATA) {
      rafId = requestAnimationFrame(() => { void tick(); });
      return;
    }
    const w = opts.video.videoWidth;
    const h = opts.video.videoHeight;
    if (w === 0 || h === 0) {
      rafId = requestAnimationFrame(() => { void tick(); });
      return;
    }
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(opts.video, 0, 0, w, h);

    busy = true;
    try {
      const text = await detector.detect(canvas, ctx);
      if (text) {
        stopped = true;
        stream.getTracks().forEach((t) => t.stop());
        opts.onResult(text);
        return;
      }
    } finally {
      busy = false;
    }
    rafId = requestAnimationFrame(() => { void tick(); });
  };

  rafId = requestAnimationFrame(() => { void tick(); });

  return {
    stop(): void {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

interface Detector {
  detect(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<string | null>;
}

async function buildDetector(): Promise<Detector> {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  if (w.BarcodeDetector) {
    try {
      const supported = (await w.BarcodeDetector.getSupportedFormats?.()) ?? [];
      if (supported.includes('qr_code')) {
        const native = new w.BarcodeDetector({ formats: ['qr_code'] });
        return {
          async detect(canvas) {
            const codes = await native.detect(canvas);
            return codes[0]?.rawValue ?? null;
          },
        };
      }
    } catch { /* fall through to jsqr */ }
  }
  // jsqr fallback (Firefox, Safari)
  const jsqrModule = await import('jsqr');
  const jsQR = jsqrModule.default;
  return {
    async detect(_canvas, ctx) {
      const w0 = ctx.canvas.width;
      const h0 = ctx.canvas.height;
      const imageData = ctx.getImageData(0, 0, w0, h0);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      });
      return code?.data ?? null;
    },
  };
}
