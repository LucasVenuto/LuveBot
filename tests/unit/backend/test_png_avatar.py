"""AV-1 (contract v0.11 section 2.1; invariants 1 and 4): `backend/png_avatar.py`, the strict PNG validator and the canonical encoder, as pure functions.
* every refusal is an `InvalidImage` (422 `invalid_image`, `details.why` from the closed list, our words, never a byte of the file); a refusal is never another exception;
* the walk: the signature, `IHDR` first and once (256 x 256, 8 bits, colour type 2 or 6, compression 0, filter 0, not interlaced: a wrong size is `bad_header`, a wrong depth, colour type or interlace
  `unsupported_format`), at most 64 chunks, every declared length fits (decided from the number, nothing that size is allocated), the CRC of EVERY chunk (ancillary too), the IDATs consecutive, `IEND` empty,
  last, with nothing after it, an unknown critical chunk refuses, an ancillary one is checked and dropped;
* the inflate: a ceiling of one byte more than the image holds (a bomb allocates nothing more), exactly the image's size, the stream ended, nothing left over;
* the unfilter: the five filters, a filter byte above 4 in any row refuses the file;
* the output: `IHDR`, one `IDAT` (filter 0 on every row, zlib level 9) and `IEND`, fresh CRCs, nothing the sender wrote outside the pixels; the same pixels give the same bytes whatever the input was; it re-encodes to
  itself; its decoded pixels are the input's.
The red team's 107 cases (test_redteam_png_avatar.py) run on this module too, and its builders are used here. Mutations: one line changed -> red."""
import functools
import hashlib
import struct
import sys
import tracemalloc
import zlib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as threads  # noqa: E402
import test_redteam_png_avatar as lume  # noqa: E402  (only its builders: `build`, `chunk`, `ihdr`, `chunks_of`, `decode`, `filtered`, `pixels`)

ROOT = Path(__file__).resolve().parents[3]
SOURCE = (ROOT / 'backend' / 'png_avatar.py').read_text()
SECRET = lume.SECRET


def load(edits=()):
    name, _ = threads.package()
    return threads.variant(name, 'png_avatar', edits)


@functools.lru_cache(maxsize=None)
def img(color, seed):
    return lume.pixels(color, seed)


@functools.lru_cache(maxsize=None)
def data_for(color, seed, kinds, level):
    """The zlib data of an image under these filters: the Python filter loop runs once per image, not once per body (the 69 mutations would repeat it)."""
    return zlib.compress(lume.filtered(img(color, seed), color, kinds), level)


@functools.lru_cache(maxsize=None)
def body(*, color=6, seed=1, kinds=(0,), level=9, **kw):
    return lume.build(img(color, seed), color, kinds, level=level, idat_override=data_for(color, seed, kinds, level), **kw)


decoded = functools.lru_cache(maxsize=None)(lume.decode)
FILT = lume.filtered(img(6, 1))
DATA = zlib.compress(FILT)


def why(m, data):
    """The refusal of `data` as its `why`: an accepted input, or any exception that is not ours, is a failure."""
    try:
        m.reencode(data)
    except Exception as error:  # noqa: BLE001
        assert type(error).__name__ == 'InvalidImage' and error.why in m.WHY, f'a refusal that is not ours: {type(error).__name__}'
        assert (error.code, error.status, error.extra) == ('invalid_image', 422, {'details': {'why': error.why}}) and str(error) == m.WHY[error.why]
        assert SECRET.decode() not in str(error) + repr(error.extra) and 'PK' not in str(error)
        return error.why
    raise AssertionError('accepted')


def heap_peak(fn):
    tracemalloc.start()
    try:
        fn()
        return tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


def checks(m):
    assert (m.SIZE, m.MAX_CHUNKS, m.READ_CAP, m.STORED_CAP, m.LENGTH_MAX, m.CHANNELS) == (256, 64, 320 * 1024, 288 * 1024, 2 ** 31 - 1, {2: 3, 6: 4})      # the numbers of 2.1
    # accepted: canonical, same pixels, five filters in one image, RGB too, deterministic, idempotent, one sha256 for any encoding
    every = body(kinds=(0, 1, 2, 3, 4), seed=5)
    out = m.reencode(every)
    parts = lume.chunks_of(out)
    assert [k for k, _, _ in parts] == [b'IHDR', b'IDAT', b'IEND'] and all(ok for _, _, ok in parts) and parts[0][1] == struct.pack('>IIBBBBB', 256, 256, 8, 6, 0, 0, 0) and parts[2][1] == b''
    assert decoded(out)[1] == img(6, 5)                                                                                       # all five filters unfilter to the sender's pixels
    raw = zlib.decompress(parts[1][1])
    assert all(raw[y * (1 + 1024)] == 0 for y in range(256)) and parts[1][1] == zlib.compress(raw, 9) and len(out) <= m.STORED_CAP
    assert m.reencode(out) == out                                                                                                 # it re-encodes to itself
    variants = [body(seed=5), body(seed=5, level=1), body(seed=5, idat_parts=7), body(seed=5, extra_before=(lume.chunk(b'tEXt', b'k\x00v'),), extra_after=(lume.chunk(b'tIME', b'\x07\xea\x0a\x1e\x00\x00\x00'),))]
    assert {hashlib.sha256(m.reencode(v)).hexdigest() for v in variants} == {hashlib.sha256(out).hexdigest()}                     # the same pixels, one identity
    rgb = m.reencode(body(color=2, seed=2))
    assert decoded(rgb) == (2, img(2, 2)) and lume.chunks_of(rgb)[0][1][9] == 2 and m.reencode(body(color=2, seed=2, extra_before=(lume.chunk(b'PLTE', bytes(range(255)) * 3 + b'\x00\x00\x00'),))) == rgb   # a suggested palette is dropped
    # the signature
    for bad in (b'', b'\x89', lume.SIG, lume.SIG[:7], b'\x88' + lume.SIG[1:] + every[8:], lume.SIG.replace(b'\r\n', b'\n') + every[8:], b'GIF89a;' + every, b'\xef\xbb\xbf' + every, b'<svg onload=1>', b'PK\x03\x04' + b'\x00' * 100, b'%PDF-1.4'):
        assert why(m, bad) in ('not_png', 'bad_chunk', 'bad_header') and (not bad.startswith(lume.SIG) or why(m, bad) != 'not_png'), bad[:12]
    assert why(m, b'GIF89a;' + every) == 'not_png' and why(m, b'\x88' + lume.SIG[1:] + every[8:]) == 'not_png' and why(m, b'\x89PNG\r\n\x1a') == 'not_png' and why(m, b'') == 'not_png'
    for odd in (None, 'png', 5, [every], {'a': 1}):
        assert why(m, odd) == 'not_png', odd
    assert m.reencode(bytearray(every)) == out and m.reencode(memoryview(every)) == out
    # the read cap
    assert why(m, b'\x00' * (m.READ_CAP + 1)) == 'too_large' and why(m, every + b'\x00' * (m.READ_CAP)) == 'too_large'
    # the header: a size is bad_header; a depth, a colour type, an interlace flag is unsupported_format
    for header in (lume.ihdr(255), lume.ihdr(257), lume.ihdr(h=255), lume.ihdr(h=257), lume.ihdr(0), lume.ihdr(h=0), lume.ihdr(2 ** 32 - 1, 2 ** 32 - 1), lume.ihdr(255, 257), lume.ihdr(comp=1), lume.ihdr(filt=1)):
        assert why(m, body(ihdr_chunk=header)) == 'bad_header', header[8:21].hex()
    for header in (lume.ihdr(depth=16), lume.ihdr(depth=1), lume.ihdr(depth=4), lume.ihdr(color=0), lume.ihdr(color=3), lume.ihdr(color=4), lume.ihdr(color=5), lume.ihdr(color=255), lume.ihdr(interlace=1), lume.ihdr(interlace=2)):
        assert why(m, body(ihdr_chunk=header)) == 'unsupported_format', header[8:21].hex()
    for header in (lume.chunk(b'IHDR', b'\x00' * 12), lume.chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 6, 0, 0, 0) + b'\x00'), lume.chunk(b'IHDR', b'')):
        assert why(m, body(ihdr_chunk=header)) == 'bad_header'
    good = lume.chunk(b'IDAT', DATA)
    assert why(m, lume.SIG + lume.chunk(b'tEXt', b'a\x00b') + lume.ihdr() + good + lume.chunk(b'IEND')) == 'bad_header' and why(m, lume.SIG + lume.chunk(b'IEND')) == 'bad_header'
    assert why(m, body(extra_before=(lume.ihdr(),))) == 'bad_chunk'                                                              # two IHDR
    header_data = struct.pack('>IIBBBBB', 256, 256, 8, 6, 0, 0, 0)
    assert why(m, lume.SIG + lume.chunk(b'tEXt', header_data) + good + lume.chunk(b'IEND')) == 'bad_header'                          # 13 bytes that LOOK like a header, in a chunk that is not IHDR
    # every CRC, ancillary ones too
    assert why(m, lume.SIG + lume.chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 6, 0, 0, 0), bad_crc=True) + good + lume.chunk(b'IEND')) == 'bad_crc'
    assert why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', DATA, bad_crc=True) + lume.chunk(b'IEND')) == 'bad_crc'
    assert why(m, lume.SIG + lume.ihdr() + good + lume.chunk(b'IEND', bad_crc=True)) == 'bad_crc' and why(m, lume.SIG + lume.ihdr() + good + lume.chunk(b'IEND', crc_value=0)) == 'bad_crc'
    for kind in (b'tEXt', b'eXIf', b'pHYs', b'prVt'):
        assert why(m, body(extra_before=(lume.chunk(kind, b'a\x00b', bad_crc=True),))) == 'bad_crc', kind
    assert why(m, body(extra_before=(lume.chunk(b'tEXt', b'a\x00b', bad_crc=True),) )) == 'bad_crc' and why(m, body(extra_after=(lume.chunk(b'tIME', b'\x00' * 7, crc_value=0),))) == 'bad_crc'
    # the CRC covers the type as well as the data
    forged = lume.chunk(b'tEXt', b'a\x00b')
    assert why(m, body(extra_before=(forged[:-4] + struct.pack('>I', zlib.crc32(b'a\x00b') & 0xFFFFFFFF),))) == 'bad_crc'
    # lengths
    data = DATA
    for length in (len(data) + 1, len(data) - 1, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF):
        assert why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', data, length=length) + lume.chunk(b'IEND')) in ('bad_chunk', 'bad_crc'), length
    assert why(m, every[:-6]) == 'bad_chunk' and why(m, every[:100]) == 'bad_chunk' and why(m, every[:-1]) == 'bad_chunk'
    assert heap_peak(lambda: why(m, lume.SIG + lume.ihdr() + struct.pack('>I', 0x7FFFFFFF) + b'IDAT' + b'x' * 64)) < 2 * 1024 * 1024
    # chunk types: four letters; an unknown critical chunk refuses; an ancillary one is dropped
    for kind in (b'\x00\x00\x00\x00', b'1234', b'tEX\x00', b'te t', b'IDA\n', b'tEX_', b'te[t', b'tEX`', b'tEX@', b'tEX\\'):
        assert why(m, body(extra_before=(lume.chunk(kind, b'x'),))) == 'bad_chunk', kind
    for kind in (b'ABCD', b'PrIv', b'PLTX', b'IHDX'):
        assert why(m, body(extra_before=(lume.chunk(kind, b'\x00\x01'),))) == 'bad_chunk', kind
    dropped = m.reencode(body(seed=3, extra_before=(lume.chunk(b'eXIf', b'GPSLatitude' + SECRET), lume.chunk(b'tEXt', b'Comment\x00' + SECRET), lume.chunk(b'acTL', struct.pack('>II', 2, 0))),
                              extra_after=(lume.chunk(b'iTXt', b'x\x00\x00\x00\x00\x00' + SECRET), lume.chunk(b'fdAT', b'\x00\x00\x00\x01' + zlib.compress(b'\x00' * 100)))))
    assert [k for k, _, _ in lume.chunks_of(dropped)] == [b'IHDR', b'IDAT', b'IEND'] and SECRET not in dropped and b'GPSLatitude' not in dropped and dropped == m.reencode(body(seed=3))
    # IDAT: consecutive, present; IEND: present, empty, last
    half = len(data) // 2
    assert why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', data[:half]) + lume.chunk(b'tEXt', b'a\x00b') + lume.chunk(b'IDAT', data[half:]) + lume.chunk(b'IEND')) == 'bad_chunk'
    assert why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', data[:half]) + lume.chunk(b'IDAT', b'') + lume.chunk(b'pHYs', b'\x00' * 9) + lume.chunk(b'IDAT', data[half:]) + lume.chunk(b'IEND')) == 'bad_chunk'
    assert m.reencode(lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', data[:half]) + lume.chunk(b'IDAT', b'') + lume.chunk(b'IDAT', data[half:]) + lume.chunk(b'IEND')) == m.reencode(body(seed=1))
    assert why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IEND')) == 'bad_chunk' and why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', data)) == 'bad_chunk'
    assert why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IEND') + lume.chunk(b'IDAT', data)) == 'bad_chunk' and why(m, body(extra_after=(lume.chunk(b'IEND'),))) == 'bad_chunk'
    assert why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', data) + lume.chunk(b'IEND', b'\x00')) == 'bad_chunk'
    for tail in (b'PK\x03\x04' + b'\x00' * 60, b'<?php system($_GET[0]); ?>', b'<script>alert(1)</script>', b'\x00', b'\n', b'GIF89a;', lume.chunk(b'IEND'), lume.SIG + lume.ihdr() + lume.chunk(b'IEND')):    # (a whole second PNG would be over the read cap: that is `too_large`, tested above)
        assert why(m, body(seed=1, tail=tail)) == 'bad_chunk', tail[:8]                                                         # nothing may follow IEND
    # at most 64 chunks, decided at the 65th
    text = lume.chunk(b'tEXt', b'k\x00v')
    assert [k for k, _, _ in lume.chunks_of(m.reencode(body(seed=1, extra_before=(text,) * 61)))] == [b'IHDR', b'IDAT', b'IEND'] and why(m, body(seed=1, extra_before=(text,) * 62)) == 'bad_chunk'
    flood = body(seed=1, extra_before=(lume.chunk(b'tEXt', b''),) * 25000)
    assert heap_peak(lambda: why(m, flood)) < 2 * 1024 * 1024
    # the inflate: a ceiling, the exact size, the end of the stream, nothing left over
    bomb = zlib.compress(b'\x00' * (16 * 1024 * 1024), 9)
    assert heap_peak(lambda: why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', bomb) + lume.chunk(b'IEND'))) < 2 * 1024 * 1024 and why(m, lume.SIG + lume.ihdr() + lume.chunk(b'IDAT', bomb) + lume.chunk(b'IEND')) == 'bad_data'
    expected = 256 * (1 + 256 * 4)
    for size in (expected + 1, expected - 1, 0, 1, expected * 2):
        assert why(m, lume.build(raw=b'\x00' * size)) == 'bad_data', size
    assert decoded(m.reencode(lume.build(raw=b'\x00' * expected)))[1] == [bytes(1024)] * 256
    assert why(m, lume.build(img(2, 2), 2, raw=b'\x00' * (256 * (1 + 256 * 3) + 1))) == 'bad_data' and m.reencode(lume.build(img(2, 2), 2, raw=b'\x00' * (256 * (1 + 256 * 3))))
    for broken in (data[:-4], data[:-1], data + b'\x00', data + zlib.compress(b'tail'), data[:-4] + b'\x00\x00\x00\x00', data[2:], b'\x78\x9c' + b'\xff' * 30, bytes([data[0] ^ 0x08]) + data[1:], b'\x78\xbb\x00\x00\x00\x00' + data[2:], b''):
        assert why(m, lume.build(img(6, 1), idat_override=broken)) == 'bad_data', broken[:6]
    # the filter bytes
    raw_rows = bytearray(FILT)
    for y, value in ((0, 5), (100, 5), (255, 255), (17, 9)):
        broken = bytearray(raw_rows)
        broken[y * 1025] = value
        assert why(m, lume.build(raw=bytes(broken))) == 'bad_data', (y, value)
    # the refusal: ours, and it says only the closed word
    assert set(m.WHY) == {'not_png', 'bad_chunk', 'bad_crc', 'bad_header', 'unsupported_format', 'bad_data', 'too_large'}
    error = m.InvalidImage('bad_crc')
    assert (error.code, error.status, error.why, error.extra, str(error)) == ('invalid_image', 422, 'bad_crc', {'details': {'why': 'bad_crc'}}, m.WHY['bad_crc'])


def test_the_validator_and_the_canonical_encoder():
    checks(load())


def test_the_module_is_pure():
    """Static: no database, no route, no file, no Hermes, no Pillow: `struct` and `zlib` and the error type, and nothing that reads or writes."""
    import ast
    tree = ast.parse(SOURCE)
    imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names} | {n.module or '.' for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    assert imported == {'struct', 'zlib', 'api_errors'}, imported
    assert not [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ('open', 'eval', 'exec', '__import__')]


MUTATIONS = {
    'the signature is not checked': ("    if body[:len(SIGNATURE)] != SIGNATURE:\n        raise InvalidImage('not_png')", "    if False:\n        raise InvalidImage('not_png')"),
    'a prefix of the signature is enough': ("body[:len(SIGNATURE)] != SIGNATURE", "body[:4] != SIGNATURE[:4]"),
    'a body that is not bytes is parsed': ("    if type(body) is not bytes:\n        raise InvalidImage('not_png')\n", ""),
    'the read cap is not applied': ("    if len(body) > READ_CAP:\n        raise InvalidImage('too_large')", "    if False:\n        raise InvalidImage('too_large')"),
    'the read cap is 1 MiB': ("READ_CAP = 320 * 1024 ", "READ_CAP = 1024 * 1024 "),
    'a CRC is not checked': ("        if struct.unpack('>I', body[position + 8 + length:position + 12 + length])[0] != zlib.crc32(kind + data) & 0xFFFFFFFF:", "        if False:"),
    'an ancillary CRC is not checked': ("        if struct.unpack('>I', body[position + 8 + length:position + 12 + length])[0] != zlib.crc32(kind + data) & 0xFFFFFFFF:", "        if kind[0] < 97 and struct.unpack('>I', body[position + 8 + length:position + 12 + length])[0] != zlib.crc32(kind + data) & 0xFFFFFFFF:"),
    'the CRC covers the data only': ("[0] != zlib.crc32(kind + data) & 0xFFFFFFFF:", "[0] != zlib.crc32(data) & 0xFFFFFFFF:"),
    'the CRC is read from the wrong place': ("body[position + 8 + length:position + 12 + length])[0] != zlib.crc32(kind + data)", "body[position + 4 + length:position + 8 + length])[0] != zlib.crc32(kind + data)"),
    'the declared length is not bounded': ("        if length > LENGTH_MAX or position + 12 + length > len(body):\n            raise InvalidImage('bad_chunk')", "        if False:\n            raise InvalidImage('bad_chunk')"),
    'a length that overruns is read as the rest': ("        if length > LENGTH_MAX or position + 12 + length > len(body):", "        if length > LENGTH_MAX:"),
    'a chunk type may be punctuation between Z and a': ("65 <= byte <= 90 or 97 <= byte <= 122 for byte in kind", "65 <= byte <= 122 for byte in kind"),
    'a chunk type may be anything': ("        if not _letters(kind):\n            raise InvalidImage('bad_chunk')", "        if False:\n            raise InvalidImage('bad_chunk')"),
    'the chunk limit is 65': ("        if count > MAX_CHUNKS:", "        if count > MAX_CHUNKS + 1:"),
    'the chunk limit is 63': ("        if count > MAX_CHUNKS:", "        if count >= MAX_CHUNKS:"),
    'there is no chunk limit': ("        if count > MAX_CHUNKS:\n            raise InvalidImage('bad_chunk')", "        if False:\n            raise InvalidImage('bad_chunk')"),
    'IHDR need not be first': ("            if kind != b'IHDR':\n                raise InvalidImage('bad_header')", "            if False:\n                raise InvalidImage('bad_header')"),
    'IHDR may have any length': ("            if length != 13:\n                raise InvalidImage('bad_header')", "            if False:\n                raise InvalidImage('bad_header')"),
    'a second IHDR is accepted': ("        elif kind == b'IHDR':\n            raise InvalidImage('bad_chunk')                                  # a second one", "        elif False:\n            raise InvalidImage('bad_chunk')"),
    'a smaller image is accepted': ("            if width != SIZE or height != SIZE or compression != 0 or filtering != 0:", "            if width > SIZE or height > SIZE or compression != 0 or filtering != 0:"),
    'only the width is checked': ("            if width != SIZE or height != SIZE or compression != 0 or filtering != 0:", "            if width != SIZE or compression != 0 or filtering != 0:"),
    'only the height is checked': ("            if width != SIZE or height != SIZE or compression != 0 or filtering != 0:", "            if height != SIZE or compression != 0 or filtering != 0:"),
    'the compression and filter methods are not checked': ("            if width != SIZE or height != SIZE or compression != 0 or filtering != 0:", "            if width != SIZE or height != SIZE:"),
    'a depth of 16 is accepted': ("            if depth != 8 or colour not in CHANNELS or interlace != 0:", "            if colour not in CHANNELS or interlace != 0:"),
    'a depth below 8 is accepted': ("            if depth != 8 or colour not in CHANNELS or interlace != 0:", "            if depth > 8 or colour not in CHANNELS or interlace != 0:"),
    'a palette image is accepted': ("            if depth != 8 or colour not in CHANNELS or interlace != 0:", "            if depth != 8 or colour not in (2, 3, 6) or interlace != 0:"),
    'a grey image is accepted': ("            if depth != 8 or colour not in CHANNELS or interlace != 0:", "            if depth != 8 or colour not in (0, 2, 6) or interlace != 0:"),
    'an interlaced image is accepted': ("            if depth != 8 or colour not in CHANNELS or interlace != 0:", "            if depth != 8 or colour not in CHANNELS:"),
    'the IDAT chunks need not be consecutive': ("            if run == 2:\n                raise InvalidImage('bad_chunk')                              # the IDATs must be consecutive", "            if False:\n                raise InvalidImage('bad_chunk')"),
    'another chunk does not end the run of IDATs': ("            if run == 1:\n                run = 2\n", "            pass\n"),
    'IEND may have data': ("            if length != 0 or position != len(body) or run == 0:", "            if position != len(body) or run == 0:"),
    'bytes may follow IEND': ("            if length != 0 or position != len(body) or run == 0:", "            if length != 0 or run == 0:"),
    'a PNG with no picture is accepted': ("            if length != 0 or position != len(body) or run == 0:", "            if length != 0 or position != len(body):"),
    'an unknown critical chunk is dropped': ("            if kind[0] < 97 and kind not in CRITICAL_KNOWN:\n                raise InvalidImage('bad_chunk')", "            if False:\n                raise InvalidImage('bad_chunk')"),
    'every critical chunk is unknown': ("            if kind[0] < 97 and kind not in CRITICAL_KNOWN:", "            if kind[0] < 97:"),
    'an ancillary chunk is unknown': ("            if kind[0] < 97 and kind not in CRITICAL_KNOWN:", "            if kind not in CRITICAL_KNOWN:"),
    'the inflate has no ceiling': ("        raw = stream.decompress(data, expected + 1)", "        raw = stream.decompress(data)"),
    'the inflate ceiling is a megabyte': ("        raw = stream.decompress(data, expected + 1)", "        raw = stream.decompress(data, 1024 * 1024)"),
    'the size is not exact': ("    if len(raw) != expected or not stream.eof or stream.unused_data:", "    if len(raw) < expected or not stream.eof or stream.unused_data:"),
    'the end of the stream is not required': ("    if len(raw) != expected or not stream.eof or stream.unused_data:", "    if len(raw) != expected or stream.unused_data:"),
    'bytes left over are accepted': ("    if len(raw) != expected or not stream.eof or stream.unused_data:", "    if len(raw) != expected or not stream.eof:"),
    'a zlib error is a crash': ("    except zlib.error:\n        raise InvalidImage('bad_data') from None", "    except ValueError:\n        raise InvalidImage('bad_data') from None"),
    'the expected size is for RGBA': ("    expected = SIZE * (1 + SIZE * channels)", "    expected = SIZE * (1 + SIZE * 4)"),
    'a filter byte above 4 is accepted': ("    if any(raw[y * (stride + 1)] > 4 for y in range(SIZE)):\n        raise InvalidImage('bad_data')", "    if False:\n        raise InvalidImage('bad_data')"),
    'a filter byte of 5 is accepted': ("    if any(raw[y * (stride + 1)] > 4 for y in range(SIZE)):", "    if any(raw[y * (stride + 1)] > 5 for y in range(SIZE)):"),
    'only the first row filter is checked': ("    if any(raw[y * (stride + 1)] > 4 for y in range(SIZE)):", "    if raw[0] > 4:"),
    'Sub is wrong': ("                if kind == 1:\n                    out[i] = (out[i] + a) & 255", "                if kind == 1:\n                    out[i] = (out[i] - a) & 255"),
    'Up is wrong': ("            row = bytes((x + b) & 255 for x, b in zip(line, prior))", "            row = bytes((x - b) & 255 for x, b in zip(line, prior))"),
    'Average is wrong': ("                    out[i] = (out[i] + ((a + prior[i]) >> 1)) & 255", "                    out[i] = (out[i] + ((a + prior[i]) >> 2)) & 255"),
    'Average rounds up': ("                    out[i] = (out[i] + ((a + prior[i]) >> 1)) & 255", "                    out[i] = (out[i] + ((a + prior[i] + 1) >> 1)) & 255"),
    'Paeth prefers c': ("    return a if pa <= pb and pa <= pc else b if pb <= pc else c", "    return a if pa <= pb and pa <= pc else b if pb < pc else c"),
    'Paeth reads the wrong neighbour': ("                    out[i] = (out[i] + _paeth(a, prior[i], prior[i - channels] if i >= channels else 0)) & 255", "                    out[i] = (out[i] + _paeth(a, prior[i], 0)) & 255"),
    'the left pixel is one byte, not one pixel': ("                a = out[i - channels] if i >= channels else 0\n", "                a = out[i - 1] if i >= 1 else 0\n"),
    'the prior row is not kept': ("        rows.append(row)\n        prior = row\n", "        rows.append(row)\n"),
    'filter 0 is not a copy': ("        if kind == 0:\n            row = line", "        if kind == 0:\n            row = bytes(len(line))"),
    'the output keeps a text chunk': ("+ _chunk(b'IEND', b'')\n    if len(out)", "+ _chunk(b'tEXt', b'k\\x00v') + _chunk(b'IEND', b'')\n    if len(out)"),
    'the output has no IEND': ("+ _chunk(b'IEND', b'')\n    if len(out)", "\n    if len(out)"),
    'the output pixels are reversed': ("b''.join(b'\\x00' + row for row in rows)", "b''.join(b'\\x00' + row for row in reversed(rows))"),
    'the output is filtered with Sub': ("b''.join(b'\\x00' + row for row in rows)", "b''.join(b'\\x01' + row for row in rows)"),
    'the output is compressed at level 1': ("zlib.compress(b''.join(b'\\x00' + row for row in rows), 9)", "zlib.compress(b''.join(b'\\x00' + row for row in rows), 1)"),
    'the output header says RGB': ("struct.pack('>IIBBBBB', SIZE, SIZE, 8, colour, 0, 0, 0)", "struct.pack('>IIBBBBB', SIZE, SIZE, 8, 2, 0, 0, 0)"),
    'the output CRC is stale': ("zlib.crc32(kind + data) & 0xFFFFFFFF)\n\n\ndef _letters", "zlib.crc32(data) & 0xFFFFFFFF)\n\n\ndef _letters"),
    'a refusal is a 400': ("super().__init__('invalid_image', WHY[why], 422,", "super().__init__('invalid_image', WHY[why], 400,"),
    'a refusal does not say why': ("{'details': {'why': why}})", "None)"),
    'a refusal has another code': ("super().__init__('invalid_image', WHY[why]", "super().__init__('bad_request', WHY[why]"),
    'a refusal says another word': ("    'bad_crc': 'This PNG failed its integrity check.',", "    'bad_crc': 'This PNG failed its integrity check.' + ' PK',"),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_is_caught(label):
    old, new = MUTATIONS[label]
    assert SOURCE.count(old) == 1, label                      # an anchor that moved fails HERE
    m = load([(old, new)])
    with pytest.raises(BaseException):  # noqa: B017
        checks(m)
