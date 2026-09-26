export const ManifestPackingErrorCode = {
  TooManyEntries: "TOO_MANY_ENTRIES",
  InvalidInput: "INVALID_INPUT",
  InvalidPacket: "INVALID_PACKET",
  UnsupportedVersion: "UNSUPPORTED_VERSION",
  IntegrityMismatch: "INTEGRITY_MISMATCH",
  MetadataMismatch: "METADATA_MISMATCH",
  ResourceLimit: "RESOURCE_LIMIT",
  CompressionError: "COMPRESSION_ERROR",
  UnsupportedRuntime: "UNSUPPORTED_RUNTIME"
} as const;

export type ManifestPackingErrorCode =
  (typeof ManifestPackingErrorCode)[keyof typeof ManifestPackingErrorCode];

/** Errors never include manifest field values or customer identifiers. */
export class ManifestPackingError extends Error {
  override readonly name = "ManifestPackingError";

  constructor(
    readonly code: ManifestPackingErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function invalid(message: string): never {
  throw new ManifestPackingError("INVALID_PACKET", message);
}

export function resource(message: string): never {
  throw new ManifestPackingError("RESOURCE_LIMIT", message);
}
