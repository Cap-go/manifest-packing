/** Binary protocol version; independent of the npm package version. */
export const MANIFEST_FORMAT_VERSION = 1 as const;
/** Default operational entry limit. It may be raised explicitly within budgets. */
export const MAX_MANIFEST_ENTRIES = 10_000 as const;

export interface ManifestEntry {
  /** Source row identity is not serialized by the manifest protocol. */
  readonly id?: number | bigint;
  /** Optional input consistency check; associate stored packets with their version. */
  readonly app_version_id?: number | bigint;
  readonly file_name: string;
  readonly s3_path: string;
  readonly file_hash: string;
  /** Null is allowed when sizes are not encoded yet. */
  readonly file_size: number | bigint | null;
}

export type ManifestEntries = ManifestEntry;

export interface DecodedManifestEntry {
  file_name: string;
  s3_path: string;
  file_hash: string;
  /** Safe integers use number; larger values use bigint. */
  /** Null when the optional size packet was not supplied. */
  file_size: number | bigint | null;
}

export interface PackedManifest {
  readonly format_version: typeof MANIFEST_FORMAT_VERSION;
  readonly entry_count: number;
  readonly total_file_size: number | bigint | null;
  /** Raw SHA-256 of the entire stored packet. */
  readonly payload_hash: Uint8Array;
  readonly manifest: Uint8Array;
  readonly manifest_size: Uint8Array | null;
  readonly manifest_size_payload_hash: Uint8Array | null;
}

export interface UnpackManifestInput {
  readonly format_version: number;
  readonly entry_count: number;
  readonly payload_hash: Uint8Array;
  readonly manifest: Uint8Array;
  readonly manifest_size?: Uint8Array | null;
  readonly manifest_size_payload_hash?: Uint8Array | null;
  /** Pass database metadata here to verify the sum as well as the entry count. */
  readonly total_file_size?: number | bigint | null;
}

export interface PackedSizeManifest {
  readonly manifest_size: Uint8Array;
  readonly manifest_size_payload_hash: Uint8Array;
  readonly total_file_size: number | bigint;
}

export interface ManifestContext {
  readonly org_id?: string;
  readonly app_id?: string;
  readonly version_name?: string;
  readonly session_key?: string;
}

export interface ManifestLimits {
  readonly maxEntries: number;
  readonly maxPacketBytes: number;
  readonly maxBlockBytes: number;
  readonly maxStringBytes: number;
  readonly maxDecodedBytes: number;
  /** Conservative operation accounting, not an isolate memory measurement. */
  readonly maxMemoryBytes: number;
}

export type Compression = "auto" | "none" | "brotli" | "zstd";

export interface PackManifestOptions {
  /** Inferred from exact source paths when omitted. Never repairs a source path. */
  readonly context?: ManifestContext;
  readonly filenameTransform?: "auto" | "raw" | "prefix";
  /** Defaults to true. False permits null sizes and omits the size packet. */
  readonly encodeSize?: boolean;
  readonly compression?: {
    readonly filenames?: Compression;
    readonly metadata?: Compression;
  };
  readonly limits?: Partial<ManifestLimits>;
}

export interface UnpackManifestOptions {
  readonly limits?: Partial<ManifestLimits>;
}

const MIB = 1024 * 1024;
export const DEFAULT_MANIFEST_LIMITS: Readonly<ManifestLimits> = Object.freeze({
  maxEntries: MAX_MANIFEST_ENTRIES,
  maxPacketBytes: 16 * MIB,
  maxBlockBytes: 16 * MIB,
  maxStringBytes: MIB,
  maxDecodedBytes: 32 * MIB,
  maxMemoryBytes: 96 * MIB
});
