#!/usr/bin/env python3
"""Simple handwriting OCR helper.

Usage:
  python3 handwriting_ocr.py /absolute/path/to/image

Dependencies:
  pip install pillow pytesseract
  Install Tesseract binary on your system.
"""
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("Missing image path", file=sys.stderr)
        return 2

    image_path = sys.argv[1]
    try:
        from PIL import Image  # type: ignore
        import pytesseract  # type: ignore
    except Exception as exc:
        print(f"Missing dependencies: {exc}", file=sys.stderr)
        return 3

    tesseract_cmd = None
    try:
        import os
        tesseract_cmd = os.environ.get("TESSERACT_CMD")
    except Exception:
        tesseract_cmd = None
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd

    try:
        img = Image.open(image_path)
    except Exception as exc:
        print(f"Cannot open image: {exc}", file=sys.stderr)
        return 4

    try:
        text = pytesseract.image_to_string(img)
    except Exception as exc:
        print(f"OCR failed: {exc}", file=sys.stderr)
        return 5

    text = text.strip()
    if not text:
        return 0

    # Basic markdown formatting: keep line breaks.
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
