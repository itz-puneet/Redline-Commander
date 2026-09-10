#!/usr/bin/env python3
"""Compare two rendered sprite sheets, allowing for Cycles' own noise floor.

Used by tools/render-sprites.sh --check.

The renderer is deterministic in every way that was in reach - fixed seed,
adaptive sampling off, a pinned thread count, and PNG metadata stripped
after writing - and most runs are byte-identical. About one run in five is
not: a single pixel lands up to 2/255 away, which is floating-point variance
in Cycles' CPU kernel, below anything a change to a model could produce.

So this compares decoded pixels with a tolerance rather than bytes. The
tolerance is deliberately tight enough that it cannot absorb a real edit:
moving a model by a hundredth of a tile repaints hundreds of pixels by far
more than two levels. Dimensions and the manifest are still compared
exactly - only the pixel values have a noise floor.

    tools/compare_sheets.py <a.png> <b.png>

Exits 0 when they match within tolerance, 1 when they do not, 2 on bad usage.
"""

import struct
import sys
import zlib

# The largest per-channel difference seen between two runs of the same
# source. A geometry change clears this by an order of magnitude.
MAX_CHANNEL_DELTA = 2
# And the most pixels allowed to differ at all. Observed: one.
MAX_DIFFERING_PIXELS = 32


def decode(path):
    """Return (width, height, RGBA bytes) for an 8-bit RGBA PNG.

    Written out rather than pulled from a library so the check has no
    dependency the rest of the repository does not already have. It handles
    exactly what the renderer writes: 8-bit RGBA, no interlacing.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("%s is not a PNG" % path)

    offset = 8
    compressed = b""
    width = height = None
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset:offset + 4])
        kind = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + length]
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if (depth, colour, interlace) != (8, 6, 0):
                raise SystemExit("%s is not 8-bit RGBA, non-interlaced" % path)
        elif kind == b"IDAT":
            compressed += body
        offset += 12 + length

    raw = zlib.decompress(compressed)
    stride = width * 4
    out = bytearray()
    previous = bytearray(stride)
    position = 0
    for _ in range(height):
        filter_type = raw[position]
        position += 1
        line = bytearray(raw[position:position + stride])
        position += stride
        # The five PNG filters, undone in place.
        if filter_type == 1:
            for x in range(4, stride):
                line[x] = (line[x] + line[x - 4]) & 255
        elif filter_type == 2:
            for x in range(stride):
                line[x] = (line[x] + previous[x]) & 255
        elif filter_type == 3:
            for x in range(stride):
                left = line[x - 4] if x >= 4 else 0
                line[x] = (line[x] + ((left + previous[x]) >> 1)) & 255
        elif filter_type == 4:
            for x in range(stride):
                left = line[x - 4] if x >= 4 else 0
                up = previous[x]
                upleft = previous[x - 4] if x >= 4 else 0
                estimate = left + up - upleft
                da, db, dc = (abs(estimate - left), abs(estimate - up),
                              abs(estimate - upleft))
                if da <= db and da <= dc:
                    nearest = left
                elif db <= dc:
                    nearest = up
                else:
                    nearest = upleft
                line[x] = (line[x] + nearest) & 255
        elif filter_type != 0:
            raise SystemExit("%s uses unknown PNG filter %d" % (path, filter_type))
        out += line
        previous = line
    return width, height, bytes(out)


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-3].strip(), file=sys.stderr)
        return 2

    first, second = sys.argv[1], sys.argv[2]
    width_a, height_a, pixels_a = decode(first)
    width_b, height_b, pixels_b = decode(second)

    if (width_a, height_a) != (width_b, height_b):
        print("ERROR: %s is %dx%d, %s is %dx%d"
              % (first, width_a, height_a, second, width_b, height_b), file=sys.stderr)
        return 1

    differing = 0
    worst = 0
    first_at = None
    for index in range(0, len(pixels_a), 4):
        delta = max(abs(pixels_a[index + c] - pixels_b[index + c]) for c in range(4))
        if delta:
            differing += 1
            if delta > worst:
                worst = delta
            if first_at is None:
                first_at = ((index // 4) % width_a, (index // 4) // width_a)

    if worst > MAX_CHANNEL_DELTA or differing > MAX_DIFFERING_PIXELS:
        print("ERROR: %s and %s differ beyond the renderer's noise floor:"
              % (first, second), file=sys.stderr)
        print("  %d pixel(s) differ (allowed %d), worst channel delta %d (allowed %d),"
              " first at %s" % (differing, MAX_DIFFERING_PIXELS, worst,
                                MAX_CHANNEL_DELTA, first_at), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
