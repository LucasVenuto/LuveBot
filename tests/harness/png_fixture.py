"""PNG builders for the avatar proofs (AV-4, contract v0.11 section 2): a canvas-like image (256 x 256 RGBA, every filter type in use, what `toBlob` writes) and the poisoned variants. Pure functions, no LuveBot import:
the same file serves tests/invariants (the routes) and tests/e2e (the screen), and tests/harness/test_png_fixture.py checks it offline against the real validator."""
import random
import struct
import zlib

SIGNATURE = b'\x89PNG\r\n\x1a\n'
SENTINEL = b'LUVEBOT-AV4-SENTINEL-0451'      # hidden in the chunks the server must drop: it must not be in what is stored, served or audited


def chunk(kind, data, crc=None):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) if crc is None else crc)


def pixels(width=256, height=256, channels=4, seed=7):
    """Deterministic canvas-like pixels (a gradient with noise): `height` rows of `width * channels` bytes."""
    rng = random.Random(seed)
    return [bytes(((x * 255 // max(width - 1, 1)) + c * 37 + y + rng.randrange(8)) % 256 for x in range(width) for c in range(channels)) for y in range(height)]


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def filtered(rows, channels):
    """The scanlines with the filter byte, the five filter types in rotation (a browser's encoder uses all of them)."""
    out, prev = bytearray(), bytes(len(rows[0]))
    for y, row in enumerate(rows):
        kind = y % 5
        left = lambda i: row[i - channels] if i >= channels else 0                          # noqa: E731
        up_left = lambda i: prev[i - channels] if i >= channels else 0                      # noqa: E731
        if kind == 0:
            line = row
        elif kind == 1:
            line = bytes((row[i] - left(i)) & 255 for i in range(len(row)))
        elif kind == 2:
            line = bytes((row[i] - prev[i]) & 255 for i in range(len(row)))
        elif kind == 3:
            line = bytes((row[i] - (left(i) + prev[i]) // 2) & 255 for i in range(len(row)))
        else:
            line = bytes((row[i] - _paeth(left(i), prev[i], up_left(i))) & 255 for i in range(len(row)))
        out += bytes([kind]) + line
        prev = row
    return bytes(out)


def build(width=256, height=256, ctype=6, depth=8, interlace=0, rows=None, seed=7, before=(), after=b'', idat=None, idat_crc=None):
    """A PNG. `before`: extra (kind, data) chunks between IHDR and IDAT; `after`: raw bytes after IEND; `idat`: the compressed stream to use instead of the real one."""
    channels = {2: 3, 6: 4}.get(ctype, 4)
    rows = rows if rows is not None else pixels(width, height, channels, seed)
    stream = idat if idat is not None else zlib.compress(filtered(rows, channels), 9)
    return (SIGNATURE + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, depth, ctype, 0, 0, interlace))
            + b''.join(chunk(kind, data) for kind, data in before) + chunk(b'IDAT', stream, idat_crc) + chunk(b'IEND', b'') + after)


def valid(seed=7, ctype=6):
    return build(ctype=ctype, seed=seed)


def with_metadata(seed=7):
    """A valid image carrying everything a camera or an editor adds, each with the sentinel: all ancillary, all with a right CRC, so the server must DROP them (never copy)."""
    exif = b'II*\x00\x08\x00\x00\x00' + SENTINEL
    return build(seed=seed, before=[(b'eXIf', exif), (b'tEXt', b'Comment\x00' + SENTINEL), (b'iTXt', b'XML:com.adobe.xmp\x00\x00\x00\x00\x00' + SENTINEL),
                                    (b'zTXt', b'Note\x00\x00' + zlib.compress(SENTINEL)), (b'pHYs', struct.pack('>IIB', 2835, 2835, 1)), (b'tIME', struct.pack('>HBBBBB', 2026, 10, 31, 1, 2, 3))])


def channels_of(png):
    """The chunk kinds of a PNG, in order (what the proof reads of what is stored)."""
    kinds, i = [], len(SIGNATURE)
    while i < len(png):
        size = struct.unpack('>I', png[i:i + 4])[0]
        kinds.append(png[i + 4:i + 8])
        i += 12 + size
    return kinds


def decoded(png):
    """The raw pixel rows of a PNG that LuveBot wrote (filter 0 on every row): to compare with the input's."""
    i, data = len(SIGNATURE), b''
    while i < len(png):
        size = struct.unpack('>I', png[i:i + 4])[0]
        if png[i + 4:i + 8] == b'IDAT':
            data += png[i + 8:i + 8 + size]
        i += 12 + size
    raw = zlib.decompress(data)
    stride = 1 + 256 * 4
    return [raw[y * stride + 1:(y + 1) * stride] for y in range(256)]


def poisoned():
    """name -> (body, expected `details.why` of the refusal): the set of the AV-4 proof (an `eXIf` chunk is NOT here: it is accepted and stripped, see `with_metadata`)."""
    wide = build(width=257, height=257)
    bomb = zlib.compress(bytes(64 * 1024 * 1024), 9)                                  # 64 MiB of zeros in about 64 KB: a decompression bomb the cap alone does not stop
    bad = bytearray(valid())
    bad[-20] ^= 0xFF                                                                  # a byte inside the IDAT data: its CRC no longer matches
    return {
        'a ZIP tail after IEND': (valid() + b'PK\x03\x04' + SENTINEL + b'\x00' * 64, 'bad_chunk'),
        'a PHP tail after IEND': (valid() + b'<?php system($_GET[0]); ?>' + SENTINEL, 'bad_chunk'),
        'a 257 x 257 image': (wide, 'bad_header'),
        'a decompression bomb': (build(idat=bomb), 'bad_data'),
        'a bad CRC': (bytes(bad), 'bad_crc'),
        '16 bits per channel': (build(depth=16), 'unsupported_format'),
        'an interlaced image': (build(interlace=1), 'unsupported_format'),
        'a JPEG': (b'\xff\xd8\xff\xe0\x00\x10JFIF\x00' + SENTINEL + b'\x00' * 200, 'not_png'),
        'an unknown critical chunk': (build(before=[(b'ABCD', SENTINEL)]), 'bad_chunk'),
    }
