#!/usr/bin/env python3
"""Write the fixtures the smoke test opens.

The fixtures are committed, so a build server needs nothing to run the test.
This script is how they are made again if they must change. Each file is
written by hand rather than by a library, so the bytes stay small and stable
and the repository gains no dependency.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent / "fixtures"


def pdf(objects: list[bytes]) -> bytes:
    """Assemble numbered objects into a PDF with a correct cross-reference table.

    Parameters
    ----------
    objects
        Object bodies, without the `N 0 obj` wrapper, in object-number order
        starting at 1.
    """
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number
        out += body
        out += b"\nendobj\n"

    start = len(out)
    count = len(objects) + 1
    out += b"xref\n0 %d\n" % count
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % count
    out += b"startxref\n%d\n%%%%EOF\n" % start
    return bytes(out)


def one_page(text: str, pages: int = 1) -> bytes:
    """A PDF of `pages` identical pages, each showing `text` in Helvetica.

    Each page also draws a blue rule. Text alone can come out invisible if a
    font substitution goes wrong, and the check must see ink either way.
    """
    stream = (
        b"BT /F1 24 Tf 72 700 Td (" + text.encode("ascii") + b") Tj ET\n"
        b"0 0 1 RG 4 w 72 640 m 400 640 l S\n"
    )
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(pages))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [" + kids.encode() + b"] /Count %d >>" % pages,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for _ in range(pages):
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>"
            % (len(objects) + 2)
        )
        objects.append(
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream"
        )
    return pdf(objects)


def png(width: int = 64, height: int = 48) -> bytes:
    """A small truecolour PNG holding a gradient, not a flat fill.

    A flat image cannot tell a drawn picture from a blank window, so the
    fixture varies along both axes.
    """
    rows = b"".join(
        bytes([0])
        + bytes(
            value for x in range(width) for value in (x * 4 % 256, y * 5 % 256, 200)
        )
        for y in range(height)
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    signature = bytes([137, 80, 78, 71, 13, 10, 26, 10])
    return (
        signature
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


MARKDOWN = r"""# Smoke test

A heading, a paragraph and some math, so the markdown path draws
something a check can see.

$$ e^{i\pi} + 1 = 0 $$

- one
- two
"""


def main() -> None:
    HERE.mkdir(parents=True, exist_ok=True)
    written = {
        "hello.pdf": one_page("pdf-next smoke test"),
        "three-pages.pdf": one_page("page", pages=3),
        "swatch.png": png(),
        "notes.md": MARKDOWN.encode("utf-8"),
    }
    for name, data in written.items():
        (HERE / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes")


if __name__ == "__main__":
    main()
