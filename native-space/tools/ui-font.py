#!/usr/bin/env python3
"""Reproduce the native font from the existing Web asset (fonttools + brotli)."""
from pathlib import Path
from fontTools.ttLib import TTFont
root = Path(__file__).resolve().parents[2]
font = TTFont(root / 'client/src/assets/fonts/fusion-pixel-12px-proportional.woff2')
font.flavor = None
font.save(root / 'native-space/assets/fonts/fusion-pixel.ttf')
