/**
 * EPUB is a zip file. This module wraps fflate for unzipping and adds two
 * small byte-level utilities used by parse.ts: XHTML decoding (UTF-8 by
 * default, honoring an XML declaration or <meta charset> if present) and
 * base64 data-URL encoding for the cover image fallback path.
 */

import { unzipSync } from "fflate";

export type ZipFiles = Record<string, Uint8Array>;

export function unzipEpub(bytes: Uint8Array): ZipFiles {
  return unzipSync(bytes);
}

export interface DecodeResult {
  text: string;
  /** True if we could not confirm the encoding from an XML declaration or
   *  <meta charset> and had to guess UTF-8. */
  guessed: boolean;
}

/**
 * Decode XHTML bytes as UTF-8 by default; respect an XML declaration
 * (`<?xml ... encoding="...">`) or `<meta charset="...">` if present and
 * supported by the platform's TextDecoder. `guessed: true` means neither
 * was usable and UTF-8 was assumed.
 */
export function decodeXhtml(bytes: Uint8Array): DecodeResult {
  // Sniff a small ASCII-safe prefix for encoding hints. Byte values in the
  // declaration itself are always ASCII regardless of the document's real
  // encoding, so this is safe even before we know what that encoding is.
  const prefixLen = Math.min(bytes.length, 1024);
  let prefix = "";
  for (let i = 0; i < prefixLen; i++) {
    prefix += String.fromCharCode(bytes[i] ?? 0);
  }

  const xmlDeclMatch = prefix.match(/<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i);
  const metaCharsetMatch = prefix.match(/<meta[^>]*\bcharset\s*=\s*["']?([a-zA-Z0-9_-]+)/i);
  const declared = xmlDeclMatch?.[1] ?? metaCharsetMatch?.[1];

  if (declared) {
    try {
      const decoder = new TextDecoder(declared);
      return { text: decoder.decode(bytes), guessed: false };
    } catch {
      // Unknown/unsupported label -- fall through to the UTF-8 guess.
    }
  }

  return { text: new TextDecoder("utf-8").decode(bytes), guessed: true };
}

/** Plain UTF-8 decode, for control files (container.xml, OPF, NCX) where
 *  SPEC.md doesn't ask for encoding sniffing. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Browser-safe base64 encode (no Node Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }
  return btoa(binary);
}

export function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}
