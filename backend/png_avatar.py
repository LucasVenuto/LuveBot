"""The avatar image (contract plugin-api v0.11 section 2.1): a strict PNG validator and a canonical encoder, as PURE functions (no database, no route, no Pillow).

LuveBot keeps a binary a person sent for the first time, so it is built as a validator and an encoder and never as a pass-through: every byte of the file is checked, then the PIXELS are encoded again by this
module, so what is stored is a PNG LuveBot wrote, never the one it received.

  reencode(body) -> bytes     the canonical PNG, or an InvalidImage (422 `invalid_image`, `details.why` from a closed list, never the file's bytes and never an exception text)

What the file must be: the signature; `IHDR` first (length 13, exactly 256 x 256, 8 bits, colour type 2 or 6, compression 0, filter 0, not interlaced); at most 64 chunks; every declared length fits in what is left;
the CRC of EVERY chunk checked; the `IDAT` chunks consecutive; `IEND` last with NOTHING after it; an unknown critical chunk refuses the file; an ancillary chunk (eXIf, tEXt, iCCP, acTL, ...) has its CRC checked and is
DROPPED, never copied. The compressed data is inflated with a ceiling (`max_length`: a bomb never allocates more than the image can hold) and must be exactly the size of the image, ended, with nothing left over;
every scanline is unfiltered in Python (a filter byte above 4 refuses the file); the output is filter 0 on every row, `zlib.compress(raw, 9)`, the chunks `IHDR`, one `IDAT`, `IEND` and nothing else, fresh CRCs:
the same pixels give the same bytes whatever the input was, so the sha256 of the stored bytes is the image's identity and re-encoding the output gives itself back."""
import struct
import zlib

from .api_errors import PluginError

SIGNATURE = b'\x89PNG\r\n\x1a\n'
SIZE = 256
MAX_CHUNKS = 64
READ_CAP = 320 * 1024        # what the route reads of a body, at most (2.1 item 1); the function refuses more too, so it is safe alone
STORED_CAP = 288 * 1024      # a valid 256 x 256 8-bit RGBA PNG is about 262.5 KB even for random noise (2.1 item 5)
LENGTH_MAX = 0x7FFFFFFF      # the PNG specification: a chunk length is at most 2**31 - 1
CHANNELS = {2: 3, 6: 4}      # the two colour types accepted: RGB and RGBA
CRITICAL_KNOWN = (b'IHDR', b'PLTE', b'IDAT', b'IEND')   # PLTE is a legal "suggested palette" in an RGB image: its CRC is checked and it is dropped like an ancillary chunk
WHY = {
    'not_png': 'This is not a PNG image.',
    'bad_chunk': 'This PNG is damaged or has parts LuveBot does not accept.',
    'bad_crc': 'This PNG failed its integrity check.',
    'bad_header': 'The image must be exactly 256 by 256 pixels.',
    'unsupported_format': 'The image must be an 8-bit RGB or RGBA PNG that is not interlaced.',
    'bad_data': 'The picture data of this PNG could not be read.',
    'too_large': 'This image is too large.',
}


class InvalidImage(PluginError):
    """`422 invalid_image` with `details.why`: our words, never the file's bytes and never a zlib or struct message."""
    def __init__(self, why):
        self.why = why
        super().__init__('invalid_image', WHY[why], 422, {'details': {'why': why}})


def _chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


def _letters(kind):
    return len(kind) == 4 and all(65 <= byte <= 90 or 97 <= byte <= 122 for byte in kind)


def _walk(body):
    """-> (colour type, the concatenated IDAT data). Every chunk is read where it says it is, checked, and only the picture's own bytes are kept."""
    position, count, header, idat, run = len(SIGNATURE), 0, None, [], 0     # run: 0 no IDAT yet, 1 inside the run of IDATs, 2 the run ended
    while True:
        if position + 12 > len(body):
            raise InvalidImage('bad_chunk')                                  # cut short, or no IEND
        length = struct.unpack('>I', body[position:position + 4])[0]
        if length > LENGTH_MAX or position + 12 + length > len(body):
            raise InvalidImage('bad_chunk')                                  # decided from the number: nothing of that size is ever allocated
        kind = body[position + 4:position + 8]
        data = body[position + 8:position + 8 + length]
        if struct.unpack('>I', body[position + 8 + length:position + 12 + length])[0] != zlib.crc32(kind + data) & 0xFFFFFFFF:
            raise InvalidImage('bad_crc')                                    # every chunk, ancillary ones too
        if not _letters(kind):
            raise InvalidImage('bad_chunk')
        count += 1
        if count > MAX_CHUNKS:
            raise InvalidImage('bad_chunk')
        position += 12 + length
        if header is None:
            if kind != b'IHDR':
                raise InvalidImage('bad_header')
            if length != 13:
                raise InvalidImage('bad_header')
            width, height, depth, colour, compression, filtering, interlace = struct.unpack('>IIBBBBB', data)
            if width != SIZE or height != SIZE or compression != 0 or filtering != 0:
                raise InvalidImage('bad_header')
            if depth != 8 or colour not in CHANNELS or interlace != 0:
                raise InvalidImage('unsupported_format')
            header = colour
        elif kind == b'IHDR':
            raise InvalidImage('bad_chunk')                                  # a second one
        elif kind == b'IDAT':
            if run == 2:
                raise InvalidImage('bad_chunk')                              # the IDATs must be consecutive
            run = 1
            idat.append(data)
        elif kind == b'IEND':
            if length != 0 or position != len(body) or run == 0:
                raise InvalidImage('bad_chunk')                              # IEND with data, anything after it (a ZIP, a PHP, another PNG), or no picture at all
            return header, b''.join(idat)
        else:
            if run == 1:
                run = 2
            if kind[0] < 97 and kind not in CRITICAL_KNOWN:
                raise InvalidImage('bad_chunk')                              # an unknown CRITICAL chunk (first letter uppercase); an ancillary one is dropped


def _inflate(data, channels):
    """The picture's bytes, EXACTLY: a ceiling of one byte more than the image holds, the stream ended, nothing left over."""
    expected = SIZE * (1 + SIZE * channels)
    stream = zlib.decompressobj()
    try:
        raw = stream.decompress(data, expected + 1)
    except zlib.error:
        raise InvalidImage('bad_data') from None
    if len(raw) != expected or not stream.eof or stream.unused_data:
        raise InvalidImage('bad_data')
    return raw


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def _unfilter(raw, channels):
    """The scanlines without their filters (types 0 to 4, in Python): the rows of the picture, joined."""
    stride = SIZE * channels
    if any(raw[y * (stride + 1)] > 4 for y in range(SIZE)):
        raise InvalidImage('bad_data')                                       # a filter byte above 4, in ANY row, before any work is done
    rows, prior = [], bytes(stride)
    for y in range(SIZE):
        base = y * (stride + 1)
        kind, line = raw[base], raw[base + 1:base + 1 + stride]
        if kind == 0:
            row = line
        elif kind == 2:
            row = bytes((x + b) & 255 for x, b in zip(line, prior))
        else:
            out = bytearray(line)
            for i in range(stride):
                a = out[i - channels] if i >= channels else 0
                if kind == 1:
                    out[i] = (out[i] + a) & 255
                elif kind == 3:
                    out[i] = (out[i] + ((a + prior[i]) >> 1)) & 255
                else:
                    out[i] = (out[i] + _paeth(a, prior[i], prior[i - channels] if i >= channels else 0)) & 255
            row = bytes(out)
        rows.append(row)
        prior = row
    return rows


def reencode(body):
    """The canonical PNG of a received one, or an InvalidImage. Pure: it reads `body`, writes nothing and keeps nothing of it but the pixels."""
    if isinstance(body, (bytearray, memoryview)):
        body = bytes(body)
    if type(body) is not bytes:
        raise InvalidImage('not_png')
    if len(body) > READ_CAP:
        raise InvalidImage('too_large')
    if body[:len(SIGNATURE)] != SIGNATURE:
        raise InvalidImage('not_png')
    colour, idat = _walk(body)
    rows = _unfilter(_inflate(idat, CHANNELS[colour]), CHANNELS[colour])
    out = SIGNATURE + _chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, colour, 0, 0, 0)) + _chunk(b'IDAT', zlib.compress(b''.join(b'\x00' + row for row in rows), 9)) + _chunk(b'IEND', b'')
    if len(out) > STORED_CAP:
        raise InvalidImage('too_large')
    return out
