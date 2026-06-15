// The gated lantern-mind URL. The worker 404s every path that doesn't carry the
// gate secret as its first segment; main reads the secret (.lantern-secrets.json)
// and the preload bridge hands the full URL over synchronously at startup — so
// renderer modules can import this as a plain const. The bare-URL fallback only
// matters if the bridge is somehow absent; it fails honest (404s).
export const MIND_URL: string =
  (window as { lantern?: { mindUrl?: string } }).lantern?.mindUrl ?? ''
