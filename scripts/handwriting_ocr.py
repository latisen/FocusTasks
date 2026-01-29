#!/usr/bin/env python3
"""Simple handwriting OCR helper.

Usage:
    python3 handwriting_ocr.py /absolute/path/to/image [tesseract|google|openai]

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
    provider = "tesseract"
    if len(sys.argv) > 2:
        provider = sys.argv[2].strip().lower()

    if provider == "google":
        return run_google_vision(image_path)
    if provider == "openai":
        return run_openai_vision(image_path)

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


def run_google_vision(image_path: str) -> int:
    try:
        import base64
        import json
        import os
        import urllib.request
    except Exception as exc:
        print(f"Missing stdlib: {exc}", file=sys.stderr)
        return 6

    api_key = os.environ.get("GOOGLE_OCR_KEY")
    if not api_key:
        print("Missing GOOGLE_OCR_KEY", file=sys.stderr)
        return 7

    try:
        with open(image_path, "rb") as f:
            content = base64.b64encode(f.read()).decode("utf-8")
    except Exception as exc:
        print(f"Cannot open image: {exc}", file=sys.stderr)
        return 4

    payload = {
        "requests": [
            {
                "image": {"content": content},
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
            }
        ]
    }

    url = f"https://vision.googleapis.com/v1/images:annotate?key={api_key}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
    except Exception as exc:
        print(f"Google Vision request failed: {exc}", file=sys.stderr)
        return 8

    try:
        parsed = json.loads(body)
        annotation = parsed["responses"][0].get("fullTextAnnotation", {})
        text = annotation.get("text", "").strip()
    except Exception as exc:
        print(f"Google Vision parse failed: {exc}", file=sys.stderr)
        return 9

    if text:
        print(text)
    return 0


def run_openai_vision(image_path: str) -> int:
    try:
        import base64
        import json
        import os
        import urllib.request
    except Exception as exc:
        print(f"Missing stdlib: {exc}", file=sys.stderr)
        return 6

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("Missing OPENAI_API_KEY", file=sys.stderr)
        return 7

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    try:
        with open(image_path, "rb") as f:
            content = base64.b64encode(f.read()).decode("utf-8")
    except Exception as exc:
        print(f"Cannot open image: {exc}", file=sys.stderr)
        return 4

    payload = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "Transcribe the handwriting in this image into Markdown. "
                            "The notes are separated by horizontal lines. For each section, "
                            "create a clear Markdown heading using H3 (###) and list the text under it. "
                            "Return only the transcribed Markdown content, with no code fences or extra text."
                        ),
                    },
                    {
                        "type": "input_image",
                        "image_url": f"data:image/png;base64,{content}",
                    },
                ],
            }
        ],
    }

    url = "https://api.openai.com/v1/responses"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
    except Exception as exc:
        print(f"OpenAI request failed: {exc}", file=sys.stderr)
        return 8

    try:
        parsed = json.loads(body)
        output = parsed.get("output", [])
        text_parts = []
        for item in output:
            for content in item.get("content", []):
                if content.get("type") == "output_text":
                    text_parts.append(content.get("text", ""))
        text = "\n".join(text_parts).strip()
    except Exception as exc:
        print(f"OpenAI parse failed: {exc}", file=sys.stderr)
        return 9

    if text:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
