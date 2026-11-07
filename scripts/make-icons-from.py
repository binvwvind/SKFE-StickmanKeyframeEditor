"""把一张方图加工成项目需要的全套应用图标（窗口 / 网页 / 安装包）。

尺寸策略：<=64px 用扁平版（去掉细节，小图标不糊），>=96px 用原图细节版。

输出：
  build/icon.png                  1024x1024  （electron 窗口 / macOS / Linux）
  build/icon.ico                  16~256 多尺寸（每个尺寸用各自合适的源图）
  pwa/icons/icon-192.png          192
  pwa/icons/icon-512.png          512
  pwa/icons/icon-maskable-512.png 512，内容缩到 80% 留安全区

用法：python scripts/make-icons-from.py <源图路径>
"""
import os
import sys

from icon_lib import load_square, make_master, art_for, save_ico, save_maskable

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SRC = sys.argv[1]
im = load_square(SRC)
master = make_master(im, 1024)
master.save("build/icon.png", "PNG", optimize=True)

# 每个尺寸用各自合适的源图：16~64 走扁平版，128/256 走细节版
save_ico("build/icon.ico", im, master, [16, 24, 32, 48, 64, 128, 256])

for size, path in ((192, "pwa/icons/icon-192.png"), (512, "pwa/icons/icon-512.png")):
    art_for(im, master, size).save(path, "PNG", optimize=True)

bg = save_maskable("pwa/icons/icon-maskable-512.png", master)
print(f"源图 {im.size[0]}x{im.size[1]} → 5 个图标已生成；maskable 底色 {bg}")
