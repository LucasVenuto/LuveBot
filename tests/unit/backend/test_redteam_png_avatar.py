"""Red team (Lume, 30/10) of AV-1, `backend/png_avatar.py` (contract v0.11 section 2.1), written BEFORE it exists (the pattern of P1-6): the module is skipped until it can be imported, and then every
case below runs against it. The contract names no function, so the tests need ONE entry point and say which:

    png_avatar.<entry>(body: bytes) -> bytes      the validator AND the canonical encoder: the PNG LuveBot writes, or a refusal.
    a refusal is an Exception with `.why` in the closed list of 2.1 item 6: not_png, bad_chunk, bad_crc, bad_header, unsupported_format, bad_data, too_large
                                                  (never an exception text, never a byte of the file: `str(error)` carries none of the input).

`<entry>` is the first of: reencode, encode, canonical, canonicalize, normalize, sanitize, to_canonical, validate_and_encode, process, clean (or the name in the environment variable
PNG_AVATAR_ENTRY). Brasa: if yours is called something else, set it in ENTRY_NAMES below (one line) and nothing else changes.

What is pinned (2.1 items 2 to 4, and the A-150 promise "never keep the received chunks"):
  * the signature, IHDR first (length 13, 256 x 256, depth 8, colour type 2 or 6, compression 0, filter 0, interlace 0), at most 64 chunks, every length fits, EVERY CRC is checked (ancillary too),
    IDATs consecutive, IEND last with NOTHING after it, an unknown critical chunk refuses, an ancillary chunk is checked and DROPPED (eXIf, tEXt, iTXt, zTXt, iCCP, pHYs, tIME, sRGB, gAMA, acTL...);
  * inflate with a ceiling: a bomb is refused without allocating more than the ceiling (measured with tracemalloc), the output is EXACTLY the expected size, the stream has ended, nothing is left over;
  * the output is canonical: IHDR + one IDAT + IEND, filter 0 on every row, zlib level 9, fresh CRCs, the same pixels give the same bytes whatever the input was (filters, IDAT split, zlib level, ancillary
    chunks), it re-encodes to itself, and its decoded pixels are the input's (checked with a decoder written here, not the module's);
  * polyglots: a tail of any kind after IEND (ZIP, PHP, HTML, another PNG, zeros), a PNG that is also something else at the front, an SVG, JPEG, GIF, WebP or HTML renamed .png: refused.
Known and NOT a defect: pixels the attacker chose can survive in the output (zlib stores incompressible data as is), so a polyglot of that kind is defeated by `Content-Type: image/png` and `nosniff` (2.2),
not by the encoder."""
import hashlib
import os
import random
import struct
import tracemalloc
import zlib

import pytest

png_avatar = pytest.importorskip('backend.png_avatar', reason='AV-1 (backend/png_avatar.py) is not written yet: these cases run the day it exists')

ENTRY_NAMES = ('reencode', 'encode', 'canonical', 'canonicalize', 'normalize', 'sanitize', 'to_canonical', 'validate_and_encode', 'process', 'clean')
WHY = {'not_png', 'bad_chunk', 'bad_crc', 'bad_header', 'unsupported_format', 'bad_data', 'too_large'}
HEADER_WHY = {'bad_header', 'unsupported_format'}            # the contract does not say which of the two a depth, a colour type or an interlace flag gets: either, never another
SIG = b'\x89PNG\r\n\x1a\n'
SECRET = b'SECRET-MARKER-9f3a'


# ---- the entry point -----------------------------------------------------------------------------------------------------------------------------
def entry():
    names = ((os.environ['PNG_AVATAR_ENTRY'],) if os.environ.get('PNG_AVATAR_ENTRY') else ()) + ENTRY_NAMES
    found = next((getattr(png_avatar, n) for n in names if callable(getattr(png_avatar, n, None))), None)
    if found is None:
        pytest.fail(f'backend/png_avatar.py has none of {names}: add the name of its entry point to ENTRY_NAMES (test_redteam_png_avatar.py)')
    return found


def run(body):
    out = entry()(bytes(body))
    out = getattr(out, 'bytes', out)
    assert isinstance(out, (bytes, bytearray)), 'the entry point must return the canonical PNG as bytes'
    return bytes(out)


def refused(body, why=None):
    """The refusal of `body`: -> its `why`. A refusal is an Exception with a closed `why`; any other exception is a defect (the route would answer 500)."""
    try:
        got = entry()(bytes(body))
    except Exception as error:  # noqa: BLE001
        reason = getattr(error, 'why', None)
        assert reason in WHY, f'a refusal must carry a closed `why` (got {type(error).__name__}: {reason!r})'
        text = str(error)
        assert SECRET.decode() not in text and 'PK' not in text and '<?php' not in text, 'a refusal must not echo the file'
        if why is not None:
            assert reason in ((why,) if isinstance(why, str) else why), (reason, why)
        return reason
    raise AssertionError(f'a hostile input was accepted ({len(bytes(getattr(got, "bytes", got)))} bytes came out)')


# ---- building PNGs by hand (independent of the module under test) ---------------------------------------------------------------------------------------
def crc(kind, data):
    return zlib.crc32(kind + data) & 0xFFFFFFFF


def chunk(kind, data=b'', length=None, bad_crc=False, crc_value=None):
    value = crc(kind, data) if crc_value is None else crc_value
    if bad_crc:
        value ^= 0x01
    return struct.pack('>I', len(data) if length is None else length) + kind + data + struct.pack('>I', value)


def ihdr(w=256, h=256, depth=8, color=6, comp=0, filt=0, interlace=0):
    return chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, depth, color, comp, filt, interlace))


def channels(color):
    return {2: 3, 6: 4, 0: 1, 4: 2, 3: 1}[color]


def pixels(color=6, seed=1, w=256, h=256):
    rng = random.Random(seed)
    n = channels(color)
    return [bytes(rng.randrange(256) for _ in range(w * n)) for _ in range(h)]


def smooth(color=6):
    n = channels(color)
    return [bytes(((x * 3 + y) % 256 if c < 3 else 255) for x in range(256) for c in range(n)) for y in range(256)]


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def filtered(rows, color=6, kinds=(0,)):
    """The scanlines with a filter type per row (cycled from `kinds`)."""
    n, out, prior = channels(color), bytearray(), bytes(len(rows[0]))
    for y, row in enumerate(rows):
        kind = kinds[y % len(kinds)]
        out.append(kind)
        for i, byte in enumerate(row):
            a = row[i - n] if i >= n else 0
            b = prior[i]
            c = prior[i - n] if i >= n else 0
            predicted = (0, a, b, (a + b) // 2, paeth(a, b, c))[kind]
            out.append((byte - predicted) & 255)
        prior = row
    return bytes(out)


def build(rows=None, color=6, kinds=(0,), level=9, idat_parts=1, extra_before=(), extra_after=(), w=256, h=256, raw=None, tail=b'', ihdr_chunk=None, idat_override=None):
    rows = pixels(color) if rows is None and raw is None else rows
    data = zlib.compress(raw if raw is not None else filtered(rows, color, kinds), level) if idat_override is None else idat_override
    step = max(1, -(-len(data) // idat_parts))
    parts = [data[i:i + step] for i in range(0, len(data), step)] or [b'']
    return (SIG + (ihdr_chunk if ihdr_chunk is not None else ihdr(w, h, 8, color)) + b''.join(extra_before) + b''.join(chunk(b'IDAT', p) for p in parts) + b''.join(extra_after)
            + chunk(b'IEND') + tail)


def chunks_of(png):
    """[(type, data, crc_ok)] of a PNG, walking it without trusting it (the reference reader)."""
    assert png[:8] == SIG
    out, i = [], 8
    while i < len(png):
        length = struct.unpack('>I', png[i:i + 4])[0]
        kind, data = png[i + 4:i + 8], png[i + 8:i + 8 + length]
        stored = struct.unpack('>I', png[i + 8 + length:i + 12 + length])[0]
        out.append((kind, data, stored == crc(kind, data)))
        i += 12 + length
    assert i == len(png)
    return out


def decode(png):
    """-> (color, rows): the pixels of a PNG by a decoder of this file (all five filters)."""
    parts = chunks_of(png)
    color = parts[0][1][9]
    n = channels(color)
    raw = zlib.decompress(b''.join(d for k, d, _ in parts if k == b'IDAT'))
    width, rows, prior = 256 * n, [], bytes(256 * n)
    for y in range(256):
        line = raw[y * (width + 1):(y + 1) * (width + 1)]
        kind, cur = line[0], bytearray(line[1:])
        for i in range(width):
            a = cur[i - n] if i >= n else 0
            b = prior[i]
            c = prior[i - n] if i >= n else 0
            cur[i] = (cur[i] + (0, a, b, (a + b) // 2, paeth(a, b, c))[kind]) & 255
        rows.append(bytes(cur))
        prior = bytes(cur)
    return color, rows


def heap_peak(fn):
    tracemalloc.start()
    try:
        fn()
        return tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


# ======================================================================== accepted: the canonical output ======================================================
@pytest.mark.parametrize('color', [6, 2])
def test_a_valid_canvas_png_comes_out_canonical_with_the_same_pixels(color):
    rows = pixels(color)
    out = run(build(rows, color))
    parts = chunks_of(out)
    assert [k for k, _, _ in parts] == [b'IHDR', b'IDAT', b'IEND'] and all(ok for _, _, ok in parts)         # nothing else, fresh CRCs
    assert parts[0][1] == struct.pack('>IIBBBBB', 256, 256, 8, color, 0, 0, 0) and parts[2][1] == b''
    got_color, got_rows = decode(out)
    assert got_color == color and got_rows == rows                                                          # the decoded pixels of the output are the input's
    raw = zlib.decompress(parts[1][1])
    assert all(raw[y * (1 + 256 * channels(color))] == 0 for y in range(256))                               # filter 0 on every row
    assert parts[1][1] == zlib.compress(raw, 9)                                                             # zlib level 9, as written in 2.1
    assert len(out) <= 288 * 1024                                                                           # the stored cap, even for random noise


def test_the_same_pixels_in_many_encodings_give_one_output_and_one_sha256():
    rows = pixels(6, seed=7)
    variants = [build(rows, kinds=(0,)), build(rows, kinds=(1,)), build(rows, kinds=(2,)), build(rows, kinds=(3,)), build(rows, kinds=(4,)), build(rows, kinds=(0, 1, 2, 3, 4)),
                build(rows, level=1), build(rows, level=0), build(rows, idat_parts=3), build(rows, idat_parts=40), build(rows, kinds=(4, 3), level=5, idat_parts=7),
                build(rows, extra_before=[chunk(b'tEXt', b'Comment\x00hello')], extra_after=[chunk(b'tIME', b'\x07\xea\x0a\x1e\x00\x00\x00')])]
    outs = [run(v) for v in variants]
    assert len({hashlib.sha256(o).hexdigest() for o in outs}) == 1
    assert run(outs[0]) == outs[0]                                                                          # re-encoding the output gives itself back
    assert run(outs[0]) == run(variants[0])                                                                 # and it is deterministic


def test_a_smooth_image_and_a_flat_one_round_trip():
    for rows in (smooth(6), smooth(2) if False else smooth(6), [bytes([10, 20, 30, 255] * 256)] * 256):
        out = run(build(rows, 6, kinds=(1, 2, 4)))
        assert decode(out)[1] == rows and run(out) == out


# ---- ancillary chunks are checked and DROPPED, never copied --------------------------------------------------------------------------------------------
ANCILLARY = {
    'tEXt': chunk(b'tEXt', b'Comment\x00' + SECRET),
    'iTXt': chunk(b'iTXt', b'XML:com.adobe.xmp\x00\x00\x00\x00\x00' + SECRET),
    'zTXt': chunk(b'zTXt', b'Comment\x00\x00' + zlib.compress(SECRET)),
    'eXIf': chunk(b'eXIf', b'MM\x00*\x00\x00\x00\x08\x00\x01\x88\x25\x00\x04\x00\x00\x00\x01\x00\x00\x00\x00' + SECRET + b'GPSLatitude'),
    'iCCP': chunk(b'iCCP', b'profile\x00\x00' + zlib.compress(SECRET * 10)),
    'pHYs': chunk(b'pHYs', struct.pack('>IIB', 2835, 2835, 1)),
    'tIME': chunk(b'tIME', b'\x07\xea\x0a\x1e\x0c\x00\x00'),
    'sRGB': chunk(b'sRGB', b'\x00'), 'gAMA': chunk(b'gAMA', struct.pack('>I', 45455)), 'cHRM': chunk(b'cHRM', b'\x00' * 32), 'bKGD': chunk(b'bKGD', b'\x00' * 6),
    'sBIT': chunk(b'sBIT', b'\x08\x08\x08\x08'), 'tRNS': chunk(b'tRNS', b'\x00' * 6), 'hIST': chunk(b'hIST', b'\x00\x01'), 'sPLT': chunk(b'sPLT', b'p\x00\x08' + b'\x00' * 6),
    'private': chunk(b'prVt', SECRET),                                      # a private ancillary chunk of someone's own
    'acTL+fcTL+fdAT': chunk(b'acTL', struct.pack('>II', 2, 0)) + chunk(b'fcTL', b'\x00' * 26) + chunk(b'fdAT', b'\x00\x00\x00\x01' + zlib.compress(b'\x00' * 1025)),
}


@pytest.mark.parametrize('name', sorted(ANCILLARY))
def test_an_ancillary_chunk_is_dropped_and_none_of_its_bytes_survive(name):
    rows = pixels(6, seed=3)
    out = run(build(rows, extra_before=[ANCILLARY[name]]))
    assert [k for k, _, _ in chunks_of(out)] == [b'IHDR', b'IDAT', b'IEND']
    assert SECRET not in out and b'GPSLatitude' not in out and b'Comment' not in out and b'XML:com.adobe' not in out
    assert out == run(build(rows))                                                                          # exactly what the same pixels give with none of it


def test_every_ancillary_chunk_at_once_and_in_the_gap_between_ihdr_and_idat_and_after_idat():
    rows = pixels(6, seed=4)
    everything = list(ANCILLARY.values())
    out = run(build(rows, extra_before=everything[:8], extra_after=everything[8:]))
    assert [k for k, _, _ in chunks_of(out)] == [b'IHDR', b'IDAT', b'IEND'] and SECRET not in out and out == run(build(rows))


@pytest.mark.parametrize('name', ['tEXt', 'eXIf', 'pHYs', 'private'])
def test_an_ancillary_chunk_with_a_bad_crc_refuses_the_file_even_though_it_would_be_dropped(name):
    kind = ANCILLARY[name][4:8]
    data = ANCILLARY[name][8:-4]
    refused(build(extra_before=[chunk(kind, data, bad_crc=True)]), 'bad_crc')


# ======================================================================== refused: not a PNG ===================================================================
@pytest.mark.parametrize('label,body', [
    ('empty', b''), ('one byte', b'\x89'), ('only the signature', SIG), ('seven bytes of it', SIG[:7]),
    ('a flipped signature byte', b'\x88' + SIG[1:] + build()[8:]), ('CRLF turned into LF (an FTP/text-mode copy)', SIG.replace(b'\r\n', b'\n') + build()[8:]),
    ('JPEG', b'\xff\xd8\xff\xe0\x00\x10JFIF\x00' + b'\x00' * 400), ('GIF', b'GIF89a\x01\x00\x01\x00\x80\x00\x00' + b'\x00' * 100), ('WebP', b'RIFF\x24\x00\x00\x00WEBPVP8 ' + b'\x00' * 40),
    ('SVG renamed .png', b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'),
    ('HTML', b'<!doctype html><script>alert(1)</script>'), ('PHP', b'<?php system($_GET[0]); ?>'), ('ZIP', b'PK\x03\x04' + b'\x00' * 200), ('text', b'GET / HTTP/1.1\r\n\r\n'),
    ('PNG magic with a NUL after it', SIG + b'\x00' * 40), ('a PNG after a leading line of text', b'GIF89a;' + build()), ('BOM + PNG', b'\xef\xbb\xbf' + build()),
])
def test_what_is_not_a_png_is_refused(label, body):
    reason = refused(body)                                                                                  # the closed list is enforced by `refused`
    if not body.startswith(SIG):
        assert reason == 'not_png'                                                                          # no signature: not a PNG, whatever else it is
    else:
        assert reason in {'bad_chunk', 'bad_header', 'bad_crc'}                                             # the signature with garbage behind it


# ======================================================================== refused: the header ==================================================================
@pytest.mark.parametrize('label,header', [
    ('width 255', ihdr(255)), ('width 257', ihdr(257)), ('height 255', ihdr(h=255)), ('height 257', ihdr(h=257)), ('width 0', ihdr(0)), ('height 0', ihdr(h=0)), ('width 65536', ihdr(65536)),
    ('width 2**31', ihdr(2 ** 31)), ('width 2**32-1', ihdr(2 ** 32 - 1, 2 ** 32 - 1)), ('depth 16', ihdr(depth=16)), ('depth 1', ihdr(depth=1)), ('depth 4', ihdr(depth=4)),
    ('colour type 0', ihdr(color=0)), ('colour type 3', ihdr(color=3)), ('colour type 4', ihdr(color=4)), ('colour type 5', ihdr(color=5)), ('colour type 255', ihdr(color=255)),
    ('compression 1', ihdr(comp=1)), ('filter method 1', ihdr(filt=1)), ('interlace 1 (Adam7)', ihdr(interlace=1)), ('interlace 2', ihdr(interlace=2)),
])
def test_a_wrong_header_is_refused(label, header):
    assert refused(build(ihdr_chunk=header)) in HEADER_WHY


@pytest.mark.parametrize('label,header', [('IHDR of 12 bytes', chunk(b'IHDR', b'\x00' * 12)), ('IHDR of 14 bytes', chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 6, 0, 0, 0) + b'\x00')),
                                          ('IHDR of 0 bytes', chunk(b'IHDR', b''))])
def test_an_ihdr_of_the_wrong_length_is_refused(label, header):
    assert refused(build(ihdr_chunk=header)) in {'bad_header', 'bad_chunk'}


def test_ihdr_must_be_first_and_only_once():
    refused(SIG + chunk(b'tEXt', b'a\x00b') + ihdr() + chunk(b'IDAT', zlib.compress(filtered(pixels()))) + chunk(b'IEND'), {'bad_header', 'bad_chunk'})
    refused(build(extra_before=[ihdr()]), {'bad_header', 'bad_chunk'})                                       # two IHDR
    refused(SIG + chunk(b'IDAT', zlib.compress(filtered(pixels()))) + ihdr() + chunk(b'IEND'), {'bad_header', 'bad_chunk'})
    refused(SIG + chunk(b'IEND'), {'bad_header', 'bad_chunk'})


def test_a_palette_png_is_refused_whatever_it_carries():
    plte = chunk(b'PLTE', bytes(range(256)) * 3)
    rows = [bytes([i % 256 for i in range(256)])] * 256
    refused(build(rows, 3, extra_before=[plte], ihdr_chunk=ihdr(color=3)), HEADER_WHY)


# ======================================================================== refused: chunks =====================================================================
def test_a_bad_crc_anywhere_refuses_the_file():
    good = chunk(b'IDAT', zlib.compress(filtered(pixels())))
    refused(SIG + ihdr_with_bad_crc() + good + chunk(b'IEND'), 'bad_crc')
    refused(SIG + ihdr() + chunk(b'IDAT', zlib.compress(filtered(pixels())), bad_crc=True) + chunk(b'IEND'), 'bad_crc')
    refused(SIG + ihdr() + good + chunk(b'IEND', bad_crc=True), 'bad_crc')
    refused(SIG + ihdr() + good + chunk(b'IEND', crc_value=0), 'bad_crc')
    refused(build(extra_before=[chunk(b'tEXt', b'a\x00b', crc_value=0)]), 'bad_crc')


def ihdr_with_bad_crc():
    return chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 6, 0, 0, 0), bad_crc=True)


def test_a_chunk_whose_declared_length_does_not_fit_is_refused_without_reading_past_the_end():
    data = zlib.compress(filtered(pixels()))
    refused(SIG + ihdr() + chunk(b'IDAT', data, length=len(data) + 1) + chunk(b'IEND'), {'bad_chunk', 'bad_crc'})
    refused(SIG + ihdr() + chunk(b'IDAT', data, length=len(data) - 1) + chunk(b'IEND'), {'bad_chunk', 'bad_crc'})
    refused(SIG + ihdr() + chunk(b'IDAT', data, length=0x7FFFFFFF) + chunk(b'IEND'), {'bad_chunk', 'too_large'})
    refused(SIG + ihdr() + chunk(b'IDAT', data, length=0x80000000) + chunk(b'IEND'), {'bad_chunk', 'too_large'})     # the PNG spec says a length is at most 2**31 - 1
    refused(SIG + ihdr() + chunk(b'IDAT', data, length=0xFFFFFFFF) + chunk(b'IEND'), {'bad_chunk', 'too_large'})
    refused(build()[:-6], {'bad_chunk', 'bad_crc'})                                                          # cut in the middle of IEND
    refused(build()[:100], {'bad_chunk', 'bad_crc', 'bad_data'})                                             # cut in the middle of IDAT


def test_a_huge_declared_length_does_not_allocate_it():
    body = SIG + ihdr() + struct.pack('>I', 0x7FFFFFFF) + b'IDAT' + b'x' * 64
    assert heap_peak(lambda: refused(body, {'bad_chunk', 'too_large'})) < 8 * 1024 * 1024


@pytest.mark.parametrize('label,kind', [('a critical chunk nobody knows', b'ABCD'), ('a critical private chunk', b'PrIv'), ('PLT*', b'PLTX'), ('a second critical-looking IHDR-like', b'IHDX')])
def test_an_unknown_critical_chunk_refuses_the_file(label, kind):
    refused(build(extra_before=[chunk(kind, b'\x00\x01')]), {'bad_chunk', 'unsupported_format'})


@pytest.mark.parametrize('kind', [b'\x00\x00\x00\x00', b'1234', b'tEX\x00', b'te t', b'\xff\xfe\xfd\xfc', b'IDA\n'])
def test_a_chunk_type_that_is_not_four_letters_is_refused(kind):
    refused(build(extra_before=[chunk(kind, b'x')]), {'bad_chunk', 'bad_crc'})


def test_the_idat_chunks_must_be_consecutive():
    data = zlib.compress(filtered(pixels()))
    half = len(data) // 2
    split = SIG + ihdr() + chunk(b'IDAT', data[:half]) + chunk(b'tEXt', b'a\x00b') + chunk(b'IDAT', data[half:]) + chunk(b'IEND')
    refused(split, {'bad_chunk', 'bad_data'})
    refused(SIG + ihdr() + chunk(b'IDAT', data[:half]) + chunk(b'IDAT', b'') + chunk(b'pHYs', b'\x00' * 9) + chunk(b'IDAT', data[half:]) + chunk(b'IEND'), {'bad_chunk', 'bad_data'})


def test_idat_must_exist_and_iend_must_exist_and_be_last():
    refused(SIG + ihdr() + chunk(b'IEND'), {'bad_chunk', 'bad_data'})                                       # no IDAT
    refused(SIG + ihdr() + chunk(b'IDAT', zlib.compress(filtered(pixels()))), {'bad_chunk'})                # no IEND
    refused(SIG + ihdr() + chunk(b'IEND') + chunk(b'IDAT', zlib.compress(filtered(pixels()))), {'bad_chunk', 'bad_data'})
    refused(build(extra_after=[chunk(b'IEND')]), 'bad_chunk')                                              # two IEND
    refused(SIG + ihdr() + chunk(b'IDAT', zlib.compress(filtered(pixels()))) + chunk(b'IEND', b'\x00'), {'bad_chunk', 'bad_crc'})    # IEND with data


def test_at_most_64_chunks():
    text = chunk(b'tEXt', b'k\x00v')
    ok = build(extra_before=[text] * 61)                                                                     # IHDR + 61 + IDAT + IEND = 64
    assert [k for k, _, _ in chunks_of(run(ok))] == [b'IHDR', b'IDAT', b'IEND']
    refused(build(extra_before=[text] * 62), 'bad_chunk')                                                    # 65
    refused(build(extra_before=[text] * 5000), {'bad_chunk', 'too_large'})


def test_a_flood_of_empty_chunks_is_refused_fast_and_small():
    body = build(smooth(6), extra_before=[chunk(b'tEXt', b'')] * 25000)
    assert len(body) < 320 * 1024
    assert heap_peak(lambda: refused(body, {'bad_chunk', 'too_large'})) < 8 * 1024 * 1024


# ======================================================================== refused: after IEND (polyglots) =========================================================
TAILS = {
    'a ZIP': b'PK\x03\x04\x14\x00\x00\x00\x08\x00' + b'\x00' * 40 + b'PK\x01\x02' + b'\x00' * 40 + b'PK\x05\x06' + b'\x00' * 18,
    'PHP': b'<?php system($_GET["c"]); ?>', 'HTML': b'<html><script>alert(document.cookie)</script>', 'zeros': b'\x00' * 1024, 'one byte': b'\x00',
    'a newline': b'\n', 'another PNG': build(smooth(6)), 'an IEND again': chunk(b'IEND'), 'a GIF': b'GIF89a;', 'a RAR': b'Rar!\x1a\x07\x00',
}


@pytest.mark.parametrize('name', sorted(TAILS))
def test_nothing_may_follow_iend(name):
    refused(build(tail=TAILS[name]), {'bad_chunk', 'bad_data'})


def test_a_png_that_is_also_a_zip_at_the_front_is_not_a_png():
    refused(b'PK\x03\x04' + b'\x00' * 26 + build(), {'not_png', 'bad_chunk'})
    refused(b'<?php /*' + build(), {'not_png', 'bad_chunk'})


# ======================================================================== refused: the compressed data =========================================================
def test_a_decompression_bomb_is_refused_without_allocating_more_than_the_ceiling():
    bomb = zlib.compress(b'\x00' * (256 * 1024 * 1024), 9)                                                    # 256 MiB of zeros in about 250 KB
    assert len(bomb) < 320 * 1024
    body = SIG + ihdr() + chunk(b'IDAT', bomb) + chunk(b'IEND')
    assert heap_peak(lambda: refused(body, 'bad_data')) < 8 * 1024 * 1024                                     # a naive zlib.decompress would hold 256 MiB


def test_a_one_kilobyte_bomb_is_refused_small():
    bomb = zlib.compress(b'\x00' * (1024 * 1024), 9)                                                          # about 1 KB that inflates to 1 MiB, 4x what 256 x 256 RGBA can hold
    assert len(bomb) < 2048
    assert heap_peak(lambda: refused(SIG + ihdr() + chunk(b'IDAT', bomb) + chunk(b'IEND'), 'bad_data')) < 4 * 1024 * 1024


def test_exactly_one_byte_too_many_and_too_few_are_refused():
    expected = 256 * (1 + 256 * 4)
    for size in (expected + 1, expected - 1, 0, 1, expected * 2):
        refused(build(raw=b'\x00' * size), 'bad_data')
    out = run(build(raw=b'\x00' * expected))                                                                  # the exact size is the only one accepted
    assert decode(out)[1] == [bytes(1024)] * 256
    expected_rgb = 256 * (1 + 256 * 3)
    refused(build(rgb := pixels(2), 2, raw=b'\x00' * (expected_rgb + 1)), 'bad_data')
    run(build(rgb, 2, raw=b'\x00' * expected_rgb))


def test_the_stream_must_have_ended_and_leave_nothing_over():
    data = zlib.compress(filtered(pixels()))
    refused(build(idat_override=data[:-4]), 'bad_data')                                                       # no Adler-32: the stream did not end
    refused(build(idat_override=data[:-1]), 'bad_data')
    refused(build(idat_override=data + b'\x00'), 'bad_data')                                                  # unused_data
    refused(build(idat_override=data + zlib.compress(b'tail')), 'bad_data')                                   # a second stream behind the first
    refused(build(idat_override=data[:-4] + b'\x00\x00\x00\x00'), 'bad_data')                                 # a wrong checksum
    refused(build(idat_override=data[2:]), 'bad_data')                                                        # raw deflate, no zlib header
    refused(build(idat_override=b'\x78\x9c' + b'\xff' * 30), 'bad_data')                                      # garbage after a header
    refused(build(idat_override=bytes([data[0] ^ 0x08]) + data[1:]), 'bad_data')                              # a wrong method in the header
    refused(build(idat_override=b'\x78\xbb\x00\x00\x00\x00' + data[2:]), 'bad_data')                          # FDICT: a preset dictionary
    refused(build(idat_override=b''), 'bad_data')


def test_a_filter_byte_above_four_in_any_row_is_refused():
    raw = bytearray(filtered(pixels()))
    row = 1 + 256 * 4
    for y, value in ((0, 5), (100, 5), (255, 255), (17, 9)):
        broken = bytearray(raw)
        broken[y * row] = value
        refused(build(raw=bytes(broken)), 'bad_data')
    assert decode(run(build(raw=bytes(raw))))[1] == pixels()                                                  # the five valid ones are accepted (the control)


def test_the_five_filters_unfilter_to_the_same_pixels_even_on_the_first_row_and_the_first_pixel():
    rows = pixels(6, seed=11)
    for kinds in ((0,), (1,), (2,), (3,), (4,), (4, 3, 2, 1, 0), (2, 2, 4, 1)):
        assert decode(run(build(rows, kinds=kinds)))[1] == rows, kinds


# ======================================================================== too large ===========================================================================
def test_an_input_over_the_read_cap_is_refused():
    big = build(pixels(6)) + b'\x00' * (330 * 1024)
    refused(big, {'too_large', 'bad_chunk'})
    refused(SIG + ihdr() + chunk(b'IDAT', b'\x00' * (330 * 1024)) + chunk(b'IEND'), {'too_large', 'bad_data', 'bad_chunk'})


def test_random_noise_the_worst_case_stays_under_the_stored_cap():
    out = run(build(pixels(6, seed=99)))
    assert len(out) <= 288 * 1024 and len(out) > 200 * 1024                                                    # about 262.5 KB: the maths of 2.1


# ======================================================================== never anything but our own PNG ==============================================================
def test_the_output_never_contains_a_byte_the_attacker_wrote_outside_the_pixels():
    attacker = b'<script>alert(1)</script>' + SECRET + b'<?php ?>' + b'PK\x03\x04'
    rows = smooth(6)
    hostile = build(rows, extra_before=[chunk(b'tEXt', b'x\x00' + attacker), chunk(b'zTXt', b'x\x00\x00' + zlib.compress(attacker)), chunk(b'eXIf', attacker)],
                    extra_after=[chunk(b'iTXt', b'x\x00\x00\x00\x00\x00' + attacker)])
    out = run(hostile)
    assert attacker not in out and SECRET not in out and b'<script' not in out and b'PK\x03' not in out and b'<?php' not in out
    assert out == run(build(rows))


def test_a_valid_png_with_junk_between_the_signature_and_ihdr_is_refused():
    refused(SIG + b'\x00' * 8 + build()[8:], {'bad_chunk', 'bad_header', 'bad_crc'})
