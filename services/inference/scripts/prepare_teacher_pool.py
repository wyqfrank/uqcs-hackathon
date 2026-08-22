#!/usr/bin/env python
"""Build the webcam-like teacher image pool from Fashion144k (Plan B, step 1).

    python services/inference/scripts/prepare_teacher_pool.py --count 25000

Samples images from the extracted Fashion144k tree and re-encodes them to look
like what the battle client actually sends: WebP, at most 640 px wide.

Fashion144k's *votes* are deliberately discarded. They measure Chictopia
engagement — photo quality, poster follower count, posting era — not outfit
quality, and the PRD's fix for that confound (residual experts) is out of scope.
Only the pixels are used here; the preference labels come from the VLM teacher
in `distil_teacher.py`.

The domain gap is the real risk. Fashion144k is well-lit full-body street-style
photography; live input is a webcam crop in a hackathon venue. Re-encoding at
the client's own resolution and codec closes part of that gap, but not the
lighting or the pose distribution. Treat the distilled student as a warm start
to be calibrated on human pairs, not as a finished ranker.
"""

from __future__ import annotations

import argparse
import io
import sys
import tarfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
ARCHIVE_PATH = REPO_ROOT / "data" / "fashion144k" / "Fashion144k_v1.tar.gz"
POOL_DIR = REPO_ROOT / "data" / "teacher-pool"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
# The client encodes captures "as WebP at up to 640 pixels wide" (PRD § System
# Design). Matching it here keeps the teacher's input in the student's domain.
MAX_WIDTH = 640
WEBP_QUALITY = 80
# Below this, an image is a thumbnail or an icon rather than an outfit photo.
MIN_SOURCE_EDGE = 256
# Fashion144k's own count, used to pick a stride before the stream is read.
ARCHIVE_IMAGE_ESTIMATE = 144_169


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=25000, help="images to sample")
    parser.add_argument("--archive", type=Path, default=ARCHIVE_PATH)
    parser.add_argument("--out", type=Path, default=POOL_DIR)
    parser.add_argument("--clear", action="store_true")
    args = parser.parse_args()

    from PIL import Image, UnidentifiedImageError

    if not args.archive.exists():
        sys.exit(f"No archive at {args.archive}. Download Fashion144k_v1.tar.gz first.")

    if args.clear and args.out.exists():
        for stale in args.out.iterdir():
            stale.unlink()
    args.out.mkdir(parents=True, exist_ok=True)

    # Read straight out of the gzip stream rather than extracting first. A full
    # extraction costs 7.8 GB of disk to obtain a sixth of it, and the archive
    # has to be decompressed sequentially either way.
    #
    # Take every nth image rather than the first n: archive order is not random,
    # and a leading slice could correlate with upload era or photographer.
    stride = max(1, ARCHIVE_IMAGE_ESTIMATE // args.count)
    print(f"streaming {args.archive.name}, taking every {stride}th image")

    seen = 0
    written = 0
    skipped = 0
    with tarfile.open(args.archive, "r|gz") as archive:
        for member in archive:
            if written >= args.count:
                break
            if not member.isfile():
                continue
            name = Path(member.name)
            if name.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            seen += 1
            if seen % stride:
                continue
            handle = archive.extractfile(member)
            if handle is None:
                continue
            try:
                with Image.open(io.BytesIO(handle.read())) as image:
                    image = image.convert("RGB")
                    if min(image.size) < MIN_SOURCE_EDGE:
                        skipped += 1
                        continue
                    if image.width > MAX_WIDTH:
                        height = round(image.height * MAX_WIDTH / image.width)
                        image = image.resize((MAX_WIDTH, height), Image.LANCZOS)
                    # Name by archive path so a pool image traces back to source.
                    stem = name.name.rsplit(".", 1)[0][:60]
                    image.save(args.out / f"{stem}.webp", "WEBP", quality=WEBP_QUALITY)
                    written += 1
            except (OSError, UnidentifiedImageError):
                skipped += 1
                continue
            if written % 2000 == 0 and written:
                print(f"  {written} written, {skipped} skipped, {seen} scanned")

    try:
        destination = args.out.relative_to(REPO_ROOT)
    except ValueError:
        destination = args.out
    print(f"\nwrote {written} images to {destination} ({skipped} skipped)")
    if written < args.count:
        print(
            f"NOTE: asked for {args.count}, got {written}. The stride assumed "
            f"{ARCHIVE_IMAGE_ESTIMATE} images; lower --count or re-run to top up."
        )


if __name__ == "__main__":
    main()
