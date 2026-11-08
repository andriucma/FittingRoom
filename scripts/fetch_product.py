#!/usr/bin/env python3
"""Download a Shopify product's JSON and all of its images.

Accepts full product URLs (any domain) or bare handles; the product is fetched from
SHOPIFY_STOREFRONT_URL (in .env.local) as <store>/products/<handle>.json.

Usage:
  .venv/bin/python scripts/fetch_product.py <product-url-or-handle> [...] [--out inputs]
Output:
  inputs/<handle>/product.json, inputs/<handle>/01.jpg, 02.jpg, ...
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Accept": "application/json,text/html;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def load_env() -> None:
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def get(url: str, accept: str | None = None) -> tuple[bytes, str]:
    headers = {**HEADERS, **({"Accept": accept} if accept else {})}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(), r.headers.get_content_type()


EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/avif": ".avif"}


def handle_of(arg: str) -> str:
    path = urlparse(arg).path if "://" in arg else arg
    return path.rstrip("/").split("/")[-1].removesuffix(".json").removesuffix(".js")


def fetch(store: str, arg: str, out_root: Path) -> Path:
    handle = handle_of(arg)
    product = json.loads(get(f"{store}/products/{handle}.json")[0])["product"]
    out = out_root / handle
    out.mkdir(parents=True, exist_ok=True)
    (out / "product.json").write_text(json.dumps(product, indent=2))
    images = sorted(product.get("images", []), key=lambda im: im.get("position", 0))
    print(f"{product['title']}  ({len(images)} images) -> {out.relative_to(ROOT)}")
    for n, im in enumerate(images, 1):
        # Ask for the original JPEG/PNG; the CDN otherwise converts to WebP/AVIF.
        data, ctype = get(im["src"].split("?")[0], accept="image/jpeg,image/png;q=0.9")
        dest = out / f"{n:02d}{EXT.get(ctype, Path(urlparse(im['src']).path).suffix or '.jpg')}"
        dest.write_bytes(data)
        print(f"  {dest.name}  {im.get('width')}x{im.get('height')}")
        time.sleep(0.2)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("products", nargs="+", help="product URLs or handles")
    ap.add_argument("--out", type=Path, default=ROOT / "inputs")
    ap.add_argument("--store", help="override SHOPIFY_STOREFRONT_URL")
    args = ap.parse_args()
    load_env()
    store = (args.store or os.environ.get("SHOPIFY_STOREFRONT_URL", "")).rstrip("/")
    if not store:
        sys.exit("Set SHOPIFY_STOREFRONT_URL in .env.local or pass --store")
    for p in args.products:
        fetch(store, p, args.out)


if __name__ == "__main__":
    main()
