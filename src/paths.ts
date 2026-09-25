import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { decodeUtf8, Reader, utf8, validatePath, Writer } from "./binary.js";
import { invalid, resource } from "./errors.js";
import type { ManifestContext, ManifestEntry } from "./types.js";

export interface Header {
  org: string;
  app: string;
  version: string;
  session: string;
  presence: number;
  mode: number;
}

export function inferContext(
  entries: readonly ManifestEntry[]
): ManifestContext {
  let inferred: ManifestContext = {};
  for (const entry of entries) {
    const match = /^orgs\/([^/]+)\/apps\/([^/]+)\/(.*)$/s.exec(entry.s3_path);
    if (!match) continue;
    const org = match[1]!;
    const app = match[2]!;
    const tail = match[3]!;
    if (
      inferred.org_id !== undefined &&
      (inferred.org_id !== org || inferred.app_id !== app)
    )
      continue;
    inferred = { ...inferred, org_id: org, app_id: app };
    if (tail.startsWith("delta/")) {
      const rest = tail.slice(6);
      const slash = rest.indexOf("/");
      const candidate = slash < 0 ? "" : rest.slice(0, slash);
      if (/^(?:[0-9a-f]{2})+$/.test(candidate)) {
        try {
          inferred = {
            ...inferred,
            session_key: decodeUtf8(Buffer.from(candidate, "hex"))
          };
        } catch {
          /* An unrecognized historical path is kept literal. */
        }
      }
    } else if (tail.endsWith("/" + entry.file_name)) {
      inferred = {
        ...inferred,
        version_name: tail.slice(0, -entry.file_name.length - 1)
      };
    }
  }
  return inferred;
}

export function pathPrefix(header: Header): string {
  return "orgs/" + header.org + "/apps/" + header.app + "/";
}

export function deltaPrefix(header: Header): string {
  return (
    pathPrefix(header) +
    "delta/" +
    (header.session ? Buffer.from(header.session).toString("hex") + "/" : "")
  );
}

export function encodedName(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

export function deltaPath(prefix: string, name: string, hash: string): string {
  return (
    prefix +
    createHash("sha256").update(hash, "utf8").digest("hex") +
    "_" +
    encodedName(name)
  );
}

export function chooseHeader(
  entries: readonly ManifestEntry[],
  context?: ManifestContext
): {
  header: Header;
  modes: Uint8Array;
} {
  const source = context ?? inferContext(entries);
  const header: Header = {
    org: source.org_id ?? "",
    app: source.app_id ?? "",
    version: source.version_name ?? "",
    session: source.session_key ?? "",
    presence: 0,
    mode: 3
  };
  const modes = new Uint8Array(entries.length);
  const canReconstruct = Boolean(header.org && header.app);
  const legacy = pathPrefix(header) + header.version + "/";
  const delta = deltaPrefix(header);
  let used = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    let mode = 0;
    if (canReconstruct) {
      if (entry.s3_path === deltaPath(delta, entry.file_name, entry.file_hash))
        mode = 2;
      else if (entry.s3_path === legacy + entry.file_name) mode = 1;
    }
    modes[i] = mode;
    used |= 1 << mode;
  }
  header.mode = used === 1 ? 0 : used === 2 ? 1 : used === 4 ? 2 : 3;
  header.presence =
    (used & 6 ? 3 : 0) |
    (used & 2 ? 4 : 0) |
    (used & 4 && header.session ? 8 : 0);
  return { header, modes };
}

export function writeHeaderStrings(
  writer: Writer,
  header: Header,
  max: number
): void {
  const fields = [header.org, header.app, header.version, header.session];
  for (let i = 0; i < 4; i++) {
    if (header.presence & (1 << i)) writer.lp(utf8(fields[i]!, max));
  }
}

export function readHeaderStrings(
  reader: Reader,
  flags: number,
  max: number
): Header {
  const values = ["", "", "", ""];
  for (let i = 0; i < 4; i++) {
    if (flags & (1 << i)) values[i] = decodeUtf8(reader.lp(max));
  }
  return {
    org: values[0]!,
    app: values[1]!,
    version: values[2]!,
    session: values[3]!,
    presence: flags & 15,
    mode: (flags >> 4) & 3
  };
}

export function requirePathHeader(header: Header, mode: number): void {
  if (mode === 1 || mode === 2) {
    if ((header.presence & 3) !== 3 || !header.org || !header.app)
      invalid("Missing path organization or app");
    if (mode === 1 && !(header.presence & 4))
      invalid("Missing legacy version name");
  }
}

export function validateContext(header: Header): void {
  // Components may not introduce absolute paths or parent traversal after joining.
  if (header.presence & 3) validatePath(pathPrefix(header) + "_context");
  if (header.presence & 4)
    validatePath(pathPrefix(header) + header.version + "/_context");
  if (header.mode !== 3) requirePathHeader(header, header.mode);
}

export interface HashData {
  kind: number;
  bytes: Uint8Array;
}

export function encodeHash(value: string, max: number): HashData {
  if (
    (value.length === 64 || value.length === 512) &&
    /^[0-9a-f]+$/.test(value)
  ) {
    return {
      kind: value.length === 64 ? 0 : 2,
      bytes: Buffer.from(value, "hex")
    };
  }
  if (value.length === 344 && /^[A-Za-z0-9+/]{342}==$/.test(value)) {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 256 && bytes.toString("base64") === value)
      return { kind: 1, bytes };
  }
  return { kind: 3, bytes: utf8(value, max) };
}

export function decodeHash(reader: Reader, max: number): string {
  const kind = reader.byte();
  if (kind === 3) return decodeUtf8(reader.lp(max));
  if (kind > 3) invalid("Unknown hash representation");
  const textLength = kind === 0 ? 64 : kind === 1 ? 344 : 512;
  if (textLength > max) resource("Hash exceeds string byte limit");
  const bytes = reader.data(kind === 0 ? 32 : 256);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    kind === 1 ? "base64" : "hex"
  );
}
