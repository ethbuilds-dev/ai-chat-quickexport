"""
Generate simple PNG icons for the ChatGPT Exporter extension.
Requires Pillow: pip install Pillow
If Pillow isn't available, creates minimal valid PNGs using pure Python.
"""

import struct
import zlib

def create_minimal_png(size, filename):
    """Create a minimal valid PNG with a simple arrow-down icon."""

    # Create pixel data — dark background with a light arrow
    pixels = []
    center = size // 2
    arrow_w = size // 3

    for y in range(size):
        row = []
        for x in range(size):
            # Background: dark navy
            r, g, b, a = 26, 26, 46, 255

            # Draw a simple down-arrow shape
            # Vertical bar
            if abs(x - center) <= size // 10 and size // 5 <= y <= size * 3 // 5:
                r, g, b = 200, 200, 220
            # Arrow head (V shape)
            elif size * 3 // 5 <= y <= size * 4 // 5:
                dist_from_center = abs(x - center)
                arrow_y = y - size * 3 // 5
                if dist_from_center <= arrow_w - arrow_y * 2 and dist_from_center >= 0:
                    r, g, b = 200, 200, 220

            row.extend([r, g, b, a])
        pixels.append(bytes(row))

    # Build PNG file
    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xFFFFFFFF)

    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA

    # IDAT
    raw = b''
    for row in pixels:
        raw += b'\x00' + row  # filter byte 0 (None) per row
    compressed = zlib.compress(raw)

    png = b'\x89PNG\r\n\x1a\n'
    png += make_chunk(b'IHDR', ihdr_data)
    png += make_chunk(b'IDAT', compressed)
    png += make_chunk(b'IEND', b'')

    with open(filename, 'wb') as f:
        f.write(png)
    print(f'Created {filename} ({size}x{size})')


if __name__ == '__main__':
    create_minimal_png(16, 'icon16.png')
    create_minimal_png(48, 'icon48.png')
    create_minimal_png(128, 'icon128.png')
    print('Done.')
