"""Tesseract with bounded execution and reversible preprocessing coordinates."""
import os
import shutil
import subprocess

import cv2
import numpy as np
from PIL import Image
import pytesseract
from pytesseract import Output

from .models import Block, ProcessingError


def capabilities() -> dict:
    executable = os.getenv("TESSERACT_CMD") or shutil.which("tesseract")
    installed, version = [], None
    if executable:
        try:
            result = subprocess.run([executable, "--list-langs"], capture_output=True, text=True, timeout=5, check=True)
            installed = sorted(line.strip() for line in result.stdout.splitlines()[1:] if line.strip())
            version = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5, check=True).stdout.splitlines()[0]
        except (OSError, subprocess.SubprocessError, IndexError):
            executable = None
    requested = [item for item in os.getenv("OCR_LANGUAGES", "eng+ben").split("+") if item]
    return {"available": executable is not None, "executable": executable, "version": version,
            "installed_languages": installed, "requested_languages": requested,
            "active_languages": [item for item in requested if item in installed],
            "missing_languages": [item for item in requested if item not in installed],
            "orientation_available": "osd" in installed}


def preprocess(image: Image.Image, orientation: int = 0):
    # EXIF correction is performed by the caller; coordinates refer to the corrected source.
    gray = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2GRAY)
    original_height, original_width = gray.shape
    transform = np.eye(3)
    if orientation:
        rotations = {
            90: (cv2.ROTATE_90_CLOCKWISE, [[0, -1, original_height], [1, 0, 0], [0, 0, 1]]),
            180: (cv2.ROTATE_180, [[-1, 0, original_width], [0, -1, original_height], [0, 0, 1]]),
            270: (cv2.ROTATE_90_COUNTERCLOCKWISE, [[0, 1, 0], [-1, 0, original_width], [0, 0, 1]]),
        }
        flag, matrix = rotations[orientation]
        gray = cv2.rotate(gray, flag)
        transform = np.asarray(matrix, dtype=float)
    gray = cv2.medianBlur(gray, 3)
    enhanced = cv2.createCLAHE(clipLimit=2, tileGridSize=(8, 8)).apply(gray)
    _, mask = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    lines = cv2.HoughLinesP(mask, 1, np.pi / 180, threshold=80, minLineLength=max(40, gray.shape[1] // 8), maxLineGap=15)
    angles = []
    if lines is not None:
        for line in np.asarray(lines).reshape(-1, 4)[:500]:
            x1, y1, x2, y2 = line
            angle = np.degrees(np.arctan2(float(y2 - y1), float(x2 - x1)))
            if abs(angle) <= 15:
                angles.append(angle)
    skew = float(np.median(angles)) if angles else 0.0
    if 0.3 <= abs(skew) <= 15:
        height, width = enhanced.shape
        affine = cv2.getRotationMatrix2D((width / 2, height / 2), skew, 1)
        enhanced = cv2.warpAffine(enhanced, affine, (width, height), flags=cv2.INTER_CUBIC, borderValue=255)
        transform = np.vstack([affine, [0, 0, 1]]) @ transform
    # Adaptive thresholding is reserved for uneven illumination/low contrast.
    grid = cv2.resize(enhanced, (8, 8), interpolation=cv2.INTER_AREA)
    adaptive = min(enhanced.shape) >= 32 and (float(gray.std()) < 35 or float(grid.std()) > 30)
    if adaptive:
        enhanced = cv2.adaptiveThreshold(enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15)
    else:
        _, enhanced = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return enhanced, np.linalg.inv(transform), {"rotation_degrees": orientation, "deskew_degrees": skew, "adaptive_threshold": adaptive}


def ocr_image(image: Image.Image) -> tuple[str, list[Block], float | None, dict, list[str]]:
    gray = np.asarray(image.convert("L"))
    if float(gray.std()) < 1.5:
        return "", [], None, {"blank": True}, ["BLANK_PAGE"]
    available = capabilities()
    if not available["available"]:
        raise ProcessingError("TESSERACT_NOT_INSTALLED", 503)
    if not available["active_languages"]:
        raise ProcessingError("OCR_LANGUAGE_DATA_MISSING", 503)
    pytesseract.pytesseract.tesseract_cmd = available["executable"]
    timeout = float(os.getenv("OCR_PAGE_TIMEOUT_SECONDS", "45"))
    warnings = ["OCR_LANGUAGE_MISSING:" + lang for lang in available["missing_languages"]]
    rotation = 0
    if available["orientation_available"]:
        try:
            osd = pytesseract.image_to_osd(image, output_type=Output.DICT, timeout=min(timeout, 10))
            if float(osd.get("orientation_conf", 0)) >= 5:
                rotation = int(osd.get("rotate", 0))
        except (pytesseract.TesseractError, RuntimeError):
            warnings.append("ORIENTATION_UNCERTAIN")
    prepared, inverse, metadata = preprocess(image, rotation)
    try:
        data = pytesseract.image_to_data(prepared, lang="+".join(available["active_languages"]),
                                         config="--psm 3", output_type=Output.DICT, timeout=timeout)
    except RuntimeError as error:
        raise ProcessingError("OCR_TIMEOUT") from error
    except pytesseract.TesseractError as error:
        raise ProcessingError("OCR_FAILED") from error
    blocks, lines = [], {}
    for index, word in enumerate(data["text"]):
        if not word.strip():
            continue
        confidence = max(0, min(100, float(data["conf"][index]))) / 100
        x, y, width, height = (float(data[key][index]) for key in ("left", "top", "width", "height"))
        corners = inverse @ np.asarray([[x, x + width, x, x + width], [y, y, y + height, y + height], [1, 1, 1, 1]])
        box = [min(image.width, max(0, float(corners[0].min()))), min(image.height, max(0, float(corners[1].min()))),
               min(image.width, max(0, float(corners[0].max()))), min(image.height, max(0, float(corners[1].max())))]
        blocks.append(Block(text=word, bounding_box=box, confidence=confidence,
                            source_reference={"ocr_word": index, "processed_bounding_box": [x, y, x + width, y + height]}))
        line = tuple(data[key][index] for key in ("block_num", "par_num", "line_num"))
        lines.setdefault(line, []).append(word)
    text = "\n".join(" ".join(words) for words in lines.values())
    average = sum(block.confidence for block in blocks) / len(blocks) if blocks else None
    if not blocks:
        warnings.append("NO_TEXT_DETECTED")
    elif average < 0.6:
        warnings.append("LOW_OCR_CONFIDENCE")
    return text, blocks, average, metadata, warnings
