/** The binary manifest format emitted by this release of the library. */
export const MANIFEST_FORMAT_VERSION = 1 as const;

/** The largest manifest accepted by {@link packManifest}. */
export const MAX_MANIFEST_ENTRIES = 10_000 as const;

/** A row from the `public.manifest` table. */
export interface ManifestEntry {
  readonly id: number;
  readonly app_version_id: number;
  readonly file_name: string;
  readonly s3_path: string;
  readonly file_hash: string;
  readonly file_size: number | null;
}

/**
 * Backwards-compatible name matching the original API proposal.
 * Each value still represents one manifest entry.
 */
export type ManifestEntries = ManifestEntry;

/** The database-ready result of packing manifest entries. */
export interface PackedManifest {
  /** Unsigned 16-bit format identifier. Currently always `1`. */
  readonly format_version: typeof MANIFEST_FORMAT_VERSION;
  /** Unsigned 32-bit number of entries encoded in `manifest`. */
  readonly entry_count: number;
  /**
   * Sum of every encoded entry's `file_size`, in bytes.
   * This is not the size of the binary `manifest` payload.
   */
  readonly total_file_size: number;
  /**
   * Raw 32-byte SHA-256 digest of the exact bytes in `manifest`.
   * Different app versions may have the same digest.
   */
  readonly payload_hash: Uint8Array;
  /** Versioned, compressed binary manifest payload. */
  readonly manifest: Uint8Array;
}

/** Fields needed to unpack a stored manifest payload. */
export type UnpackManifestInput = Pick<
  PackedManifest,
  "format_version" | "entry_count" | "payload_hash" | "manifest"
>;

/** Machine-readable error codes emitted by this package. */
export const ManifestPackingErrorCode = {
  TooManyEntries: "TOO_MANY_ENTRIES",
  NotImplemented: "NOT_IMPLEMENTED"
} as const;

export type ManifestPackingErrorCode =
  (typeof ManifestPackingErrorCode)[keyof typeof ManifestPackingErrorCode];

/** The only error type intentionally thrown by this package. */
export class ManifestPackingError extends Error {
  override readonly name = "ManifestPackingError";

  constructor(
    readonly code: ManifestPackingErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * Packs database manifest rows into a compressed binary manifest.
 *
 * Encoding will be introduced with the first defined binary format.
 */
export function packManifest(
  entries: readonly ManifestEntries[]
): PackedManifest {
  if (entries.length > MAX_MANIFEST_ENTRIES) {
    throw new ManifestPackingError(
      ManifestPackingErrorCode.TooManyEntries,
      `Manifest entries cannot exceed ${MAX_MANIFEST_ENTRIES}`
    );
  }

  throw new ManifestPackingError(
    ManifestPackingErrorCode.NotImplemented,
    "Manifest packing is not yet implemented"
  );
}

/**
 * Unpacks a versioned binary manifest into database manifest rows.
 *
 * Decoding will be introduced with the first defined binary format.
 */
export function unpackManifest(_input: UnpackManifestInput): ManifestEntry[] {
  throw new ManifestPackingError(
    ManifestPackingErrorCode.NotImplemented,
    "Manifest unpacking is not yet implemented"
  );
}
