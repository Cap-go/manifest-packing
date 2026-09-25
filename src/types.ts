/** Binary protocol version; independent of the npm package version. */
export const MANIFEST_FORMAT_VERSION = 0 as const;
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
  /** Null source values are rejected. Big integers are lossless through 2^63-1. */
  readonly file_size: number | bigint | null;
}

export type ManifestEntries = ManifestEntry;

export interface DecodedManifestEntry {
  file_name: string;
  s3_path: string;
  file_hash: string;
  /** Safe integers use number; larger values use bigint. */
  file_size: number | bigint;
}

export interface PackedManifest {
  readonly format_version: typeof MANIFEST_FORMAT_VERSION;
  readonly entry_count: number;
  readonly total_file_size: number | bigint;
  /** Raw SHA-256 of the entire stored packet. */
  readonly payload_hash: Uint8Array;
  readonly manifest: Uint8Array;
}

export interface UnpackManifestInput {
  readonly format_version: number;
  readonly entry_count: number;
  readonly payload_hash: Uint8Array;
  readonly manifest: Uint8Array;
  /** Pass database metadata here to verify the sum as well as the entry count. */
  readonly total_file_size?: number | bigint;
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
  /** Delta mode requires nondecreasing sizes after stable filename sorting. */
  readonly fileSizeMode?: "absolute" | "delta";
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
