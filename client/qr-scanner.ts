/**
 * In-page QR scanner using getUserMedia + jsqr. The decoder is dynamically
 * imported on first use to keep the main client bundle lean.
 *
 * Calls onResult(text) when a QR is decoded (the encoded text — for our
 * pairing flow this will be a `?pair=…` URL). Throws on permission denial
 * or no camera available.
 */

export interface QrScannerHandle {
  stop(): void;
}

export async function startQrScanner(opts: {
  video: HTMLVideoElement;
  onResult: (text: string) => void;
  onError?: (err: Error) => void;
}): Promise<QrScannerHandle> {
  // Lazy-load jsqr only when the user actually opens the scanner.
  const jsqrModule = await import('jsqr');
  const jsQR = jsqrModule.default;

  // Request the rear-facing camera if available (better for QR scanning).
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
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

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Could not get 2D canvas context');
  }

  let stopped = false;
  let rafId = 0;

  const tick = () => {
    if (stopped) return;
    if (opts.video.readyState !== opts.video.HAVE_ENOUGH_DATA) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    const w = opts.video.videoWidth;
    const h = opts.video.videoHeight;
    if (w === 0 || h === 0) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(opts.video, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    });
    if (code && code.data) {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      opts.onResult(code.data);
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);

  return {
    stop(): void {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
