# Manifest binary protocol 1

One independently decodable packet represents one app version. The external
`payload_hash` is the 32-byte SHA-256 of the entire packet. External
`format_version` and `entry_count` must match. Sizes live only in the optional
size packet; supply it together with its SHA-256 hash to recover sizes and verify
`total_file_size`. Without it, decoded `file_size` is `null`. All string bytes are exact, strict UTF-8, with BOM and normalization
preserved. Lengths count bytes.

## Packet

`U(n)` is canonical unsigned base-128 VarUInt, low seven bits first, high bit
continuation. `LP(s)` is `U(byte_length)` followed by exact bytes. No ZigZag.

| Order | Field            | Encoding                                                  |
| ----: | ---------------- | --------------------------------------------------------- |
|     1 | Protocol version | Two-byte big-endian `00 01`                               |
|     2 | Entry count      | `U(count)`                                                |
|     3 | Header flags     | One byte, below                                           |
|     4 | Header strings   | Present strings in bit order 0 through 3, each `LP(UTF8)` |
|     5 | Filename block   | Framed block                                              |
|     6 | Metadata block   | Framed block                                              |
|     7 | End              | No trailing bytes                                         |

| Header bit | Meaning                                          |
| ---------- | ------------------------------------------------ |
| 0          | `org_id` present                                 |
| 1          | `app_id` present                                 |
| 2          | `version_name` present                           |
| 3          | `session_key` present                            |
| 4–5        | Path mode: 0 literal, 1 legacy, 2 delta, 3 mixed |
| 6          | Filename transform: 0 raw, 1 prefix-coded        |
| 7          | Reserved; must be 0                              |

Mixed mode stores one additional mode byte per
entry, limited to 0, 1, or 2. Reconstructed legacy and delta paths require
nonempty org/app fields. Legacy additionally requires the version field.

## Blocks

Both blocks use `compression_id:byte`, `U(raw_length)`, `U(stored_length)`, then
exactly `stored_length` bytes. IDs are 0 uncompressed, 1 Brotli, and 2 Zstandard;
all other IDs are rejected. Raw lengths must match for ID 0. Compressed blocks
contain exactly one fully consumed stream/frame, with exactly `raw_length` output
bytes. External dictionaries and concatenated/skippable frames are unsupported.
Decoder resource limits apply before allocation, including native window bounds.

## Filename entries

The block contains exactly the outer entry count, with no repeated count.

| Transform | Each filename                                                       |
| --------- | ------------------------------------------------------------------- |
| Raw       | `LP(filename UTF8)`                                                 |
| Prefix    | `U(common_prefix_byte_length)`, exact suffix bytes, `00` terminator |

The predecessor starts empty. Prefix length must be maximal and no longer than
the predecessor. It can end inside a UTF-8 codepoint; validate the complete
reconstructed filename. NUL is invalid in filenames. Duplicate names use the
entire predecessor as prefix and an empty suffix; they remain separate entries.
The writer stably sorts complete tuples by exact filename bytes. The decoder
preserves encoded order and does not require sorted input.

## Metadata entries

Metadata entry `i` belongs to filename `i`.

| Order | Field                                      | Encoding             |
| ----: | ------------------------------------------ | -------------------- |
|     1 | Per-entry path mode, only for mixed header | One byte: 0, 1, or 2 |
|     2 | Literal path, only for effective mode 0    | `LP(path UTF8)`      |
|     3 | Entry tag                                  | One random byte      |
|     4 | Hash kind                                  | One byte             |
|     5 | Hash data                                  | Representation below |

The encoder draws one independent random tag per sorted entry. It is a lightweight
ordering sanity check, not an authenticity guarantee; the full main-packet hash
in the size packet binds the packets together.

## Optional size packet

The external `manifest_size_payload_hash` is SHA-256 of every byte of
`manifest_size`. Both fields must be present together, or both absent. Neither
packet is a proof that storage receipts were checked; the caller must establish
that before writing a size packet. `packSizeManifest` verifies that provided
filename/path/hash tuples match the main packet in its stable sorted order.
Late sidecar generation rejects duplicate identities with differing sizes:
the size-free main packet cannot distinguish those duplicates.

| Order | Field                      | Encoding                                   |
| ----: | -------------------------- | ------------------------------------------ |
|     1 | Protocol version           | Two-byte big-endian `00 01`                |
|     2 | Main packet `payload_hash` | Exactly 32 bytes                           |
|     3 | Entry count                | `U(count)`, equal to the main packet count |
|     4 | Entries                    | Repeated `count` times, table below        |
|     5 | End                        | No trailing bytes                          |

| Order | Per-entry field | Encoding                                        |
| ----: | --------------- | ----------------------------------------------- |
|     1 | Entry tag       | One byte, equal to the corresponding main entry |
|     2 | File size       | `U(size)`, absolute bytes, at most `2^63 - 1`   |

Sizes and their sum cannot exceed `2^63 - 1`; negative/null sizes cannot be
encoded. The sidecar preserves zero-byte files. Its entry order must be exactly
the main packet's order. The tag adds only an 8-bit mismatch check for each
position; it is not a cryptographic receipt or a substitute for comparing source
entry identities when packing.

| Hash kind | Data             | Reconstructed text                     |
| --------: | ---------------- | -------------------------------------- |
|         0 | 32 bytes         | 64 lowercase hexadecimal characters    |
|         1 | 256 bytes        | Standard padded Base64, 344 characters |
|         2 | 256 bytes        | 512 lowercase hexadecimal characters   |
|         3 | `LP(exact UTF8)` | Original text                          |

The writer uses a binary representation only if it reproduces the input text
exactly. All other valid text uses kind 3. These kinds describe representation;
they do not establish cryptographic validity or encryption state.

Let `P = orgs/<org_id>/apps/<app_id>/` using exact header values.

| Effective path mode | Reconstruction                                                                        |
| ------------------- | ------------------------------------------------------------------------------------- |
| Literal             | Exact stored path                                                                     |
| Legacy              | `P + version_name + "/" + file_name`                                                  |
| Delta               | `P + "delta/" + session_directory + SHA256(hash_text).hex_lower + "_" + encoded_name` |

`session_directory` is empty when session is absent/empty, otherwise the lowercase
hex encoding of the session's UTF-8 bytes followed by `/`. `encoded_name` applies
JavaScript `encodeURIComponent` independently to each slash-separated filename
segment, retaining the slashes. The hash uses the exact reconstructed **hash text**,
not its decoded binary hash bytes. Source paths are compared byte for byte before
using reconstruction; historical exceptions remain literal.

Filenames and final paths must be nonempty relative paths without backslashes,
NUL, drive-absolute prefixes, or `.`/`..` segments. The codec does not authorize
access to the resulting storage object.

## Synthetic header example

Two entries, org `o`, app `a`, version `v`, legacy paths, prefix-coded filenames,
begin:

```text
00 01 | 02 | 57 | 01 6f | 01 61 | 01 76
version count flags    org      app      version
```

`0x57 = 0x07 | (1 << 4) | (1 << 6)`. Independent fixtures construct packets
without using the encoder. Protocol 0 packets are intentionally rejected.
