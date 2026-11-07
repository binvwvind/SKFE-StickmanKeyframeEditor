"""把一张方图加工成项目需要的全套应用图标。

输出：
  build/icon.png                  1024x1024  （electron 窗口 / macOS / Linux）
  build/icon.ico                  多尺寸      （Windows 安装包与任务栏）
  pwa/icons/icon-192.png          192
  pwa/icons/icon-512.png          512
  pwa/icons/icon-maskable-512.png 512，内容缩到 80% 留安全区（Android 会裁成圆形）

用法：python scripts/make-icons-from.py <源图路径>
"""
import sys
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1]
im = Image.open(SRC).convert("RGB")

# 源图不是正方形时居中裁成正方形
w, h = im.size
side = min(w, h)
if w != h:
    im = im.crop(((w - side) // 2, (h - side) // 2,
                  (w - side) // 2 + side, (h - side) // 2 + side))

# 主图：放大到 1024。轻微锐化补偿放大损失
master = im.resize((1024, 1024), Image.LANCZOS)
master = master.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
master.save("build/icon.png", "PNG", optimize=True)

# Windows ICO：多尺寸，让任务栏/开始菜单/文件列表各取合适的
master.save("build/icon.ico", format="ICO",
            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# PWA 普通图标
master.resize((512, 512), Image.LANCZOS).save("pwa/icons/icon-512.png", "PNG", optimize=True)
master.resize((192, 192), Image.LANCZOS).save("pwa/icons/icon-192.png", "PNG", optimize=True)

# ---- maskable ----
# 内容缩到 80% 留安全区；底色取「缩放后图像边缘的中位色」而不是原图角落色，
# 否则会出现一圈明显的方形色块接缝；边缘再羽化 12px，让被截断的放射线自然淡出。
inner_size = int(512 * 0.8)
inner = master.resize((inner_size, inner_size), Image.LANCZOS)

edge = []
for x in range(inner_size):
    edge.append(inner.getpixel((x, 0)))
    edge.append(inner.getpixel((x, inner_size - 1)))
for y in range(inner_size):
    edge.append(inner.getpixel((0, y)))
    edge.append(inner.getpixel((inner_size - 1, y)))
bg = tuple(sorted(p[c] for p in edge)[len(edge) // 2] for c in range(3))

canvas = Image.new("RGB", (512, 512), bg)
feather = Image.new("L", (inner_size, inner_size), 255)
d = ImageDraw.Draw(feather)
f = 12
for i in range(f):
    d.rectangle([i, i, inner_size - 1 - i, inner_size - 1 - i],
                outline=int(255 * (i + 1) / (f + 1)))
canvas.paste(inner, ((512 - inner_size) // 2, (512 - inner_size) // 2), feather)
canvas.save("pwa/icons/icon-maskable-512.png", "PNG", optimize=True)

print(f"源图 {w}x{h} → 已生成 5 个文件；maskable 底色 {bg}")
