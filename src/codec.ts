import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  Budget,
  decodeUtf8,
  limitsFor,
  MAX_SIZE,
  publicSize,
  Reader,
  sizeValue,
  utf8,
  validatePath,
  Writer
} from "./binary.js";
import {
  blockLength,
  compressBlock,
  decompress,
  NATIVE_WORKSPACE_BYTES,
  readBlock,
  writeBlock,
  type Block
} from "./compression.js";
import { invalid, ManifestPackingError, resource } from "./errors.js";
import {
  chooseHeader,
  decodeHash,
  deltaPrefix,
  encodeHash,
  encodePathName,
  PATH_HASH_SCRATCH_BYTES,
  PathHasher,
  pathPrefix,
  readHeaderStrings,
  requirePathHeader,
  validateContext,
  writeHeaderStrings
} from "./paths.js";
import {
  MANIFEST_FORMAT_VERSION,
  type DecodedManifestEntry,
  type ManifestEntry,
  type PackedManifest,
  type PackedSizeManifest,
  type PackManifestOptions,
  type UnpackManifestInput,
  type UnpackManifestOptions
} from "./types.js";

interface Prepared {
  entry: ManifestEntry;
  name: Buffer;
  size: bigint | null;
}

function digest(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function addSize(
  left: number | bigint,
  right: number | bigint
): number | bigint {
  if (typeof left === "number" && typeof right === "number") {
    const sum = left + right;
    if (Number.isSafeInteger(sum)) return sum;
  }
  const sum = BigInt(left) + BigInt(right);
  if (sum > MAX_SIZE) invalid("File-size sum exceeds signed bigint");
  return sum;
}

function encodeSizePacket(
  mainHash: Uint8Array,
  tags: Uint8Array,
  sizes: readonly bigint[],
  limit: number
): PackedSizeManifest {
  const writer = new Writer(limit);
  writer.byte(0);
  writer.byte(MANIFEST_FORMAT_VERSION);
  writer.data(mainHash);
  writer.uint(sizes.length);
  let total = 0n;
  for (let i = 0; i < sizes.length; i++) {
    writer.byte(tags[i]!);
    writer.size(sizes[i]!);
    total += sizes[i]!;
    if (total > MAX_SIZE)
      throw new ManifestPackingError(
        "INVALID_INPUT",
        "File-size sum exceeds signed bigint"
      );
  }
  const manifest_size = new Uint8Array(writer.finish());
  return {
    manifest_size,
    manifest_size_payload_hash: digest(manifest_size),
    total_file_size: publicSize(total)
  };
}

/** Encode one version; stably sort whole entries by exact UTF-8 name bytes. */
export function packManifest(
  entries: readonly ManifestEntry[],
  options: PackManifestOptions = {}
): PackedManifest {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Packing options must be an object"
    );
  }
  if (options.context !== undefined) {
    if (
      !options.context ||
      typeof options.context !== "object" ||
      Array.isArray(options.context)
    ) {
      throw new ManifestPackingError(
        "INVALID_INPUT",
        "Manifest context must be an object"
      );
    }
  }
  const limits = limitsFor(options.limits);
  if (!Array.isArray(entries))
    throw new ManifestPackingError("INVALID_INPUT", "Entries must be an array");
  if (entries.length > limits.maxEntries) {
    throw new ManifestPackingError(
      "TOO_MANY_ENTRIES",
      `Manifest entries cannot exceed ${limits.maxEntries}`
    );
  }
  const transform = options.filenameTransform ?? "auto";
  const encodeSize = options.encodeSize ?? true;
  if (
    !["auto", "raw", "prefix"].includes(transform) ||
    typeof encodeSize !== "boolean"
  ) {
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Unknown filename transform or encodeSize value"
    );
  }
  const prepared: Prepared[] = [];
  let nameBytes = 0;
  let sourceBytes = 0;
  let tailEstimate = 0;
  let version: number | bigint | undefined;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.file_name !== "string" ||
      typeof entry.s3_path !== "string" ||
      typeof entry.file_hash !== "string"
    ) {
      throw new ManifestPackingError("INVALID_INPUT", "Invalid manifest entry");
    }
    if (entry.app_version_id !== undefined) {
      const value = entry.app_version_id;
      if (!(
        (typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0) ||
        (typeof value === "bigint" && value >= 0n && value <= MAX_SIZE)
      )) {
        throw new ManifestPackingError(
          "INVALID_INPUT",
          "Invalid version identifier"
        );
      }
      if (
        version !== undefined &&
        BigInt(version) !== BigInt(entry.app_version_id)
      ) {
        throw new ManifestPackingError(
          "INVALID_INPUT",
          "Entries must belong to one version"
        );
      }
      version = entry.app_version_id;
    }
    const name = utf8(entry.file_name, limits.maxStringBytes);
    // Validate before hashing/path inference can normalize malformed UTF-16.
    const path = utf8(entry.s3_path, limits.maxStringBytes);
    const hash = utf8(entry.file_hash, limits.maxStringBytes);
    validatePath(entry.file_name, true);
    validatePath(entry.s3_path, true);
    const size = entry.file_size === null ? null : sizeValue(entry.file_size);
    if (size === null && encodeSize)
      throw new ManifestPackingError(
        "INVALID_INPUT",
        "Cannot encode unknown file size"
      );
    nameBytes += name.length;
    sourceBytes += name.length + path.length + hash.length;
    tailEstimate += path.length + hash.length + 32;
    if (sourceBytes > limits.maxDecodedBytes)
      resource("Source text exceeds decoded byte limit");
    if (
      48 * 1024 * 1024 +
        entries.length * 256 +
        sourceBytes * 2 +
        nameBytes * 4 >
      limits.maxMemoryBytes
    ) {
      resource("Encoding exceeds working-memory budget");
    }
    prepared.push({ entry, name, size });
  }
  prepared.sort((a, b) => Buffer.compare(a.name, b.name));
  const tags = randomBytes(prepared.length);
  const ordered = prepared.map((item) => item.entry);
  for (const value of Object.values(options.context ?? {})) {
    if (value !== undefined) utf8(value, limits.maxStringBytes);
  }
  const { header, modes } = chooseHeader(ordered, options.context);
  validateContext(header);
  const tail = new Writer(
    limits.maxBlockBytes,
    Math.min(tailEstimate, limits.maxBlockBytes)
  );
  const rawNames =
    transform === "prefix"
      ? undefined
      : new Writer(
          limits.maxBlockBytes,
          Math.min(nameBytes + entries.length * 4, limits.maxBlockBytes)
        );
  const prefixNames =
    transform === "raw"
      ? undefined
      : new Writer(
          limits.maxBlockBytes,
          Math.min(nameBytes + entries.length * 4, limits.maxBlockBytes)
        );
  let previousName: Uint8Array = new Uint8Array();
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i]!;
    const mode = modes[i]!;
    rawNames?.lp(item.name);
    if (prefixNames) {
      let prefix = 0;
      const length = Math.min(previousName.length, item.name.length);
      while (prefix < length && previousName[prefix] === item.name[prefix])
        prefix++;
      prefixNames.uint(prefix);
      prefixNames.data(item.name.subarray(prefix));
      prefixNames.byte(0);
      previousName = item.name;
    }
    if (header.mode === 3) tail.byte(mode);
    if (mode === 0) tail.lp(utf8(item.entry.s3_path, limits.maxStringBytes));
    tail.byte(tags[i]!);
    const hash = encodeHash(item.entry.file_hash, limits.maxStringBytes);
    tail.byte(hash.kind);
    if (hash.kind === 3) tail.lp(hash.bytes);
    else tail.data(hash.bytes);
  }
  // Quality-11 encoding has substantially more workspace than decoding.
  if (
    48 * 1024 * 1024 +
      sourceBytes * 2 +
      entries.length * 256 +
      nameBytes * 4 +
      tail.length * 4 >
    limits.maxMemoryBytes
  ) {
    resource("Encoding buffers exceed working-memory budget");
  }
  let names: Block | undefined;
  let nameTransform = 0;
  if (rawNames)
    names = compressBlock(
      rawNames.finish(),
      options.compression?.filenames ?? "auto",
      true
    );
  if (prefixNames) {
    const candidate = compressBlock(
      prefixNames.finish(),
      options.compression?.filenames ?? "auto",
      true
    );
    if (!names || blockLength(candidate) < blockLength(names)) {
      names = candidate;
      nameTransform = 1;
    }
  }
  if (!names) invalid("Missing filename encoding");
  const tails = compressBlock(
    tail.finish(),
    options.compression?.metadata ?? "auto",
    false
  );
  const writer = new Writer(limits.maxPacketBytes);
  writer.byte(0);
  writer.byte(MANIFEST_FORMAT_VERSION);
  writer.uint(entries.length);
  writer.byte(header.presence | (header.mode << 4) | (nameTransform << 6));
  writeHeaderStrings(writer, header, limits.maxStringBytes);
  writeBlock(writer, names);
  writeBlock(writer, tails);
  const manifest = new Uint8Array(writer.finish());
  const payload_hash = digest(manifest);
  const sizes = encodeSize
    ? encodeSizePacket(
        payload_hash,
        tags,
        prepared.map((item) => item.size!),
        limits.maxPacketBytes
      )
    : null;
  return {
    format_version: MANIFEST_FORMAT_VERSION,
    entry_count: entries.length,
    total_file_size: sizes?.total_file_size ?? null,
    payload_hash,
    manifest,
    manifest_size: sizes?.manifest_size ?? null,
    manifest_size_payload_hash: sizes?.manifest_size_payload_hash ?? null
  };
}

/** Decode the main packet while retaining its per-entry size-binding tags. */
function decodeMain(
  input: UnpackManifestInput,
  options: UnpackManifestOptions = {}
): { rows: DecodedManifestEntry[]; tags: Uint8Array; maxPacketBytes: number } {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Unpacking options must be an object"
    );
  }
  const limits = limitsFor(options.limits);
  if (!input || input.format_version !== MANIFEST_FORMAT_VERSION) {
    throw new ManifestPackingError(
      "UNSUPPORTED_VERSION",
      "Unsupported manifest format version"
    );
  }
  if (
    !(input.manifest instanceof Uint8Array) ||
    !(input.payload_hash instanceof Uint8Array)
  ) {
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Manifest and payload hash must be byte arrays"
    );
  }
  if (input.manifest.length > limits.maxPacketBytes)
    resource("Packet exceeds byte limit");
  if (
    input.payload_hash.length !== 32 ||
    !timingSafeEqual(digest(input.manifest), input.payload_hash)
  ) {
    throw new ManifestPackingError(
      "INTEGRITY_MISMATCH",
      "Manifest payload hash mismatch"
    );
  }
  const reader = new Reader(input.manifest);
  if (reader.byte() !== 0 || reader.byte() !== MANIFEST_FORMAT_VERSION) {
    throw new ManifestPackingError(
      "UNSUPPORTED_VERSION",
      "Unsupported embedded manifest version"
    );
  }
  const count = reader.uint(limits.maxEntries);
  if (count !== input.entry_count)
    throw new ManifestPackingError("METADATA_MISMATCH", "Entry count mismatch");
  const flags = reader.byte();
  if (flags & 128) invalid("Reserved header flag is set");
  const header = readHeaderStrings(reader, flags, limits.maxStringBytes);
  validateContext(header);
  const namesBlock = readBlock(reader, limits.maxBlockBytes);
  const tailsBlock = readBlock(reader, limits.maxBlockBytes);
  reader.end();
  if (count > namesBlock.rawLength || count * 2 > tailsBlock.rawLength)
    invalid("Entry count cannot fit declared blocks");
  const fixedBytes =
    input.manifest.byteLength +
    (input.manifest_size instanceof Uint8Array
      ? input.manifest_size.byteLength
      : 0) +
    namesBlock.rawLength * 2 +
    tailsBlock.rawLength * 2 +
    count * 256 +
    limits.maxStringBytes * 2 +
    PATH_HASH_SCRATCH_BYTES +
    NATIVE_WORKSPACE_BYTES;
  const budget = new Budget(limits, fixedBytes);
  const nameData = decompress(namesBlock);
  const tailData = decompress(tailsBlock);
  // Memory checkpoint: decoded blocks alive.
  const names = new Reader(nameData);
  const tails = new Reader(tailData);
  // oxlint-disable-next-line unicorn/no-new-array -- Fixed-size output avoids an O(n) initialization pass.
  const rows: DecodedManifestEntry[] = new Array(count);
  const tags = new Uint8Array(count);
  const prefixMode = (flags & 64) !== 0;
  let scratch = new Uint8Array(Math.min(256, limits.maxStringBytes));
  let previousLength = 0;
  let previousName = "";
  const legacy = pathPrefix(header) + header.version + "/";
  const delta = deltaPrefix(header);
  const legacyLength = Buffer.byteLength(legacy);
  const deltaLength = Buffer.byteLength(delta);
  const pathHasher = new PathHasher();
  for (let i = 0; i < count; i++) {
    let name: string;
    let nameLength: number;
    if (prefixMode) {
      const prefix = names.uint(limits.maxStringBytes);
      if (prefix > previousLength)
        invalid("Filename prefix exceeds predecessor");
      const start = names.offset;
      const end = nameData.indexOf(0, start);
      if (end < 0) invalid("Missing filename terminator");
      const suffixLength = end - start;
      nameLength = prefix + suffixLength;
      if (nameLength > limits.maxStringBytes)
        resource("Filename exceeds byte limit");
      if (
        suffixLength &&
        prefix < previousLength &&
        scratch[prefix] === nameData[start]
      )
        invalid("Filename prefix is not maximal");
      budget.text(nameLength);
      if (nameLength > scratch.length) {
        const grown = new Uint8Array(
          Math.min(
            limits.maxStringBytes,
            Math.max(nameLength, scratch.length * 2)
          )
        );
        grown.set(scratch.subarray(0, prefix));
        scratch = grown;
      }
      scratch.set(nameData.subarray(start, end), prefix);
      names.offset = end + 1;
      name =
        suffixLength === 0 && prefix === previousLength
          ? previousName
          : decodeUtf8(scratch.subarray(0, nameLength));
      previousLength = nameLength;
      previousName = name;
    } else {
      const bytes = names.lp(limits.maxStringBytes);
      nameLength = bytes.length;
      budget.text(nameLength);
      name = decodeUtf8(bytes);
    }
    validatePath(name);
    const mode = header.mode === 3 ? tails.byte() : header.mode;
    if (mode > 2) invalid("Invalid mixed-entry path mode");
    requirePathHeader(header, mode);
    let path = "";
    if (mode === 0) {
      const bytes = tails.lp(limits.maxStringBytes);
      budget.text(bytes.length);
      path = decodeUtf8(bytes);
    }
    tags[i] = tails.byte();
    const hash = decodeHash(tails, limits.maxStringBytes);
    const hashLength = Buffer.byteLength(hash);
    budget.text(hashLength);
    if (mode === 1) {
      const length = legacyLength + nameLength;
      if (length > limits.maxStringBytes)
        resource("Reconstructed path exceeds byte limit");
      budget.text(length);
      path = legacy + name;
    } else if (mode === 2) {
      const encoded = encodePathName(name);
      const length = deltaLength + 65 + encoded.length;
      if (length > limits.maxStringBytes)
        resource("Reconstructed path exceeds byte limit");
      budget.text(length);
      path = delta + pathHasher.digest(hash, hashLength) + "_" + encoded;
    }
    validatePath(path);
    rows[i] = {
      file_name: name,
      s3_path: path,
      file_hash: hash,
      file_size: null
    };
  }
  names.end();
  tails.end();
  return { rows, tags, maxPacketBytes: limits.maxPacketBytes };
}

/** Attach verified sizes to an existing main packet without changing that packet. */
export function packSizeManifest(
  input: UnpackManifestInput,
  entries: readonly ManifestEntry[],
  options: UnpackManifestOptions = {}
): PackedSizeManifest {
  const { rows, tags, maxPacketBytes } = decodeMain(input, options);
  if (!Array.isArray(entries) || entries.length !== rows.length)
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Size entries do not match manifest count"
    );
  const limits = limitsFor(options.limits);
  const ordered = entries.map((entry) => ({
    entry,
    name: utf8(entry?.file_name, limits.maxStringBytes)
  }));
  ordered.sort((a, b) => Buffer.compare(a.name, b.name));
  const sizes = ordered.map(({ entry }, i) => {
    const row = rows[i]!;
    if (
      entry.file_name !== row.file_name ||
      entry.s3_path !== row.s3_path ||
      entry.file_hash !== row.file_hash
    )
      throw new ManifestPackingError(
        "METADATA_MISMATCH",
        "Size entry does not match manifest"
      );
    const size = sizeValue(entry.file_size);
    const previous = ordered[i - 1]?.entry;
    if (
      previous?.file_name === entry.file_name &&
      previous.s3_path === entry.s3_path &&
      previous.file_hash === entry.file_hash &&
      sizeValue(previous.file_size) !== size
    )
      throw new ManifestPackingError(
        "METADATA_MISMATCH",
        "Duplicate identities have ambiguous sizes"
      );
    return size;
  });
  return encodeSizePacket(input.payload_hash, tags, sizes, maxPacketBytes);
}

/** Decode with integrity, canonical framing, path, integer and resource checks. */
export function unpackManifest(
  input: UnpackManifestInput,
  options: UnpackManifestOptions = {}
): DecodedManifestEntry[] {
  const packet = input?.manifest_size;
  const hash = input?.manifest_size_payload_hash;
  const hasSize = packet != null;
  if (hasSize !== (hash != null))
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Size packet and hash must be supplied together"
    );
  if (
    hasSize &&
    (!(packet instanceof Uint8Array) || !(hash instanceof Uint8Array))
  )
    throw new ManifestPackingError(
      "INVALID_INPUT",
      "Size packet and hash must be byte arrays"
    );
  if (hasSize && packet.length > limitsFor(options?.limits).maxPacketBytes)
    resource("Size packet exceeds byte limit");
  const { rows, tags } = decodeMain(input, options);
  if (!hasSize) return rows;
  if (hash!.length !== 32 || !timingSafeEqual(digest(packet), hash!))
    throw new ManifestPackingError(
      "INTEGRITY_MISMATCH",
      "Size packet hash mismatch"
    );
  const reader = new Reader(packet);
  if (reader.byte() !== 0 || reader.byte() !== MANIFEST_FORMAT_VERSION)
    throw new ManifestPackingError(
      "UNSUPPORTED_VERSION",
      "Unsupported size packet version"
    );
  if (!timingSafeEqual(reader.data(32), input.payload_hash))
    throw new ManifestPackingError(
      "INTEGRITY_MISMATCH",
      "Size packet targets another manifest"
    );
  if (reader.uint(rows.length) !== rows.length)
    throw new ManifestPackingError(
      "METADATA_MISMATCH",
      "Size entry count mismatch"
    );
  let total: number | bigint = 0;
  for (let i = 0; i < rows.length; i++) {
    if (reader.byte() !== tags[i])
      throw new ManifestPackingError(
        "METADATA_MISMATCH",
        "Size entry tag mismatch"
      );
    const size = reader.size();
    rows[i]!.file_size = size;
    total = addSize(total, size);
  }
  reader.end();
  if (
    input.total_file_size != null &&
    sizeValue(input.total_file_size) !== BigInt(total)
  )
    throw new ManifestPackingError(
      "METADATA_MISMATCH",
      "Total file size mismatch"
    );
  return rows;
}
