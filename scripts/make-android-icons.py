"""生成 Android 原生启动图标（mipmap 各密度），供 CI 在 `cap add android` 之后覆盖。

为什么需要单独一套：
  Android 工程的图标来自 Capacitor 模板（蓝色默认 logo），不会自动读 build/icon.png。
  必须把各密度的 ic_launcher*.png 覆盖到 android/app/src/main/res/mipmap-* 才会生效。

输出目录：native/android-res/values/ic_launcher_background.xml  自适应图标底层颜色

用法：python scripts/make-android-icons.py <源图路径>
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1]
OUT = os.path.join("native", "android-res")

# 密度 -> (传统图标边长, 自适应图标画布边长=108dp)
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

im = Image.open(SRC).convert("RGB")
w, h = im.size
side = min(w, h)
if w != h:
    im = im.crop(((w - side) // 2, (h - side) // 2,
                  (w - side) // 2 + side, (h - side) // 2 + side))

BG = (255, 255, 255)
master = im.resize((1024, 1024), Image.LANCZOS)
master = master.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))

made = 0
for name, (legacy, adaptive) in DENSITIES.items():
    d = os.path.join(OUT, f"mipmap-{name}")
    os.makedirs(d, exist_ok=True)

    # 1) 传统方形图标（Android 8 以下 / 部分启动器）
    sq = master.resize((legacy, legacy), Image.LANCZOS).convert("RGB")
    sq.save(os.path.join(d, "ic_launcher.png"), "PNG", optimize=True)
    made += 1

    # 2) 圆形图标（部分启动器强制圆形，需要自己裁好，否则会显示成方形套圆框）
    circle = Image.new("RGB", (legacy, legacy), BG)
    mask = Image.new("L", (legacy, legacy), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, legacy - 1, legacy - 1), fill=255)
    circle.paste(sq, (0, 0), mask)
    circle.save(os.path.join(d, "ic_launcher_round.png"), "PNG", optimize=True)
    made += 1

    # 3) 自适应图标前景（Android 8+）：画布 108dp，内容缩到 72% 躲开外圈裁切。
    #    图案自身是白底，与底层白色背景无缝衔接，所以这里保持不透明即可。
    fg = Image.new("RGB", (adaptive, adaptive), BG)
    inner = int(adaptive * 0.72)
    art = master.resize((inner, inner), Image.LANCZOS)
    fg.paste(art, ((adaptive - inner) // 2, (adaptive - inner) // 2))
    fg.save(os.path.join(d, "ic_launcher_foreground.png"), "PNG", optimize=True)
    made += 1

# 自适应图标底层颜色，与图案底色一致
vals = os.path.join(OUT, "values")
os.makedirs(vals, exist_ok=True)
with open(os.path.join(vals, "ic_launcher_background.xml"), "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
            '    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n')

print(f"源图 {w}x{h} → 生成 {made} 个 PNG + 1 个颜色资源，输出到 {OUT}/")
