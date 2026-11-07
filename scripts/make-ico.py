"""把 build/icon.png 转成 Windows 多尺寸 .ico（Pillow）。"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(ROOT, 'build', 'icon.png')
dst = os.path.join(ROOT, 'build', 'icon.ico')

im = Image.open(src).convert('RGBA')
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
im.save(dst, format='ICO', sizes=sizes)
print('ico ok:', dst, os.path.getsize(dst), 'bytes')

# macOS 的 .icns 交给 electron-builder 在 mac 上从 png 自动生成，这里不生成。
