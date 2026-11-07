"""图标处理公共库：给 make-icons-from.py 和 make-android-icons.py 共用。

核心思路：
  一张细节丰富的图，在小尺寸下会糊成一团（蜘蛛网、溅射线在 16px 都变成灰噪点）。
  所以按尺寸分两档：
    · 大尺寸（>80）  → 用原图，保留细节
    · 小尺寸（<=80） → 用"扁平版"：量化成黑白红三色

扁平版怎么保证小尺寸不糊、边缘又不脏：
  1. 先在「2× 目标尺寸」上分类成三色（此时蜘蛛网这类细线已被平均掉）
  2. LANCZOS 缩到目标尺寸（自然抗锯齿）
  3. 再按最近色重新量化回三色 —— 去掉红白之间混出来的粉色过渡
  另外 <=24px 额外膨胀 1px，防止细线在极低像素下断开。
"""
from PIL import Image, ImageDraw, ImageFilter

RED = (200, 32, 48)
BLACK = (17, 17, 17)
WHITE = (255, 255, 255)

FLAT_THRESHOLD = 80  # 小于等于这个尺寸走扁平版


def load_square(path):
    """读图并居中裁成正方形"""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    s = min(w, h)
    if w != h:
        im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    return im


def make_master(im, size=1024):
    """细节版母版：放大 + 轻微锐化"""
    m = im.resize((size, size), Image.LANCZOS)
    return m.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))


def _classify(base, dilate=0):
    """把图分成黑 / 红 / 白三色，可选膨胀"""
    n = base.size[0]
    px = base.load()
    black = Image.new("L", (n, n), 0)
    red = Image.new("L", (n, n), 0)
    bp, rp = black.load(), red.load()
    for y in range(n):
        for x in range(n):
            r, g, b = px[x, y]
            if r > 125 and r - max(g, b) > 42:
                rp[x, y] = 255
            elif (r + g + b) / 3 < 95:
                bp[x, y] = 255
    if dilate:
        k = 2 * dilate + 1
        black = black.filter(ImageFilter.MaxFilter(k))
        red = red.filter(ImageFilter.MaxFilter(k))
    out = Image.new("RGB", (n, n), WHITE)
    op = out.load()
    for y in range(n):
        for x in range(n):
            if bp[x, y] > 128:
                op[x, y] = BLACK
            elif rp[x, y] > 128:
                op[x, y] = RED
    return out


def _requantize(img):
    """按最近色重新归到三色，去掉缩放混出的粉色过渡"""
    n = img.size[0]
    px = img.load()
    out = Image.new("RGB", (n, n), WHITE)
    op = out.load()
    for y in range(n):
        for x in range(n):
            r, g, b = px[x, y]
            dw = (r - 255) ** 2 + (g - 255) ** 2 + (b - 255) ** 2
            dk = (r - 17) ** 2 + (g - 17) ** 2 + (b - 17) ** 2
            dr = (r - 200) ** 2 + (g - 32) ** 2 + (b - 48) ** 2
            op[x, y] = WHITE if dw <= dk and dw <= dr else (BLACK if dk <= dr else RED)
    return out


def make_flat(im, size):
    """扁平版：返回 size×size 的三色硬边图"""
    work = _classify(im.resize((size * 2, size * 2), Image.LANCZOS),
                     dilate=1 if size <= 24 else 0)
    return _requantize(work.resize((size, size), Image.LANCZOS))


def art_for(im, master, size, flat_threshold=FLAT_THRESHOLD):
    """按尺寸返回该用的图：小尺寸走扁平版，大尺寸走细节版"""
    if size <= flat_threshold:
        return make_flat(im, size)
    return master.resize((size, size), Image.LANCZOS)


def save_ico(path, im, master, sizes):
    """自己拼 ICO，让每个尺寸能用不同的源图（Pillow 自带的只接受单张图）

    ICO 结构：6 字节头 + 每个尺寸 16 字节目录项 + PNG 数据（Vista 起支持 PNG 条目）
    """
    import struct
    import io

    payloads = []
    for s in sizes:
        buf = io.BytesIO()
        art_for(im, master, s).save(buf, format="PNG", optimize=True)
        payloads.append((s, buf.getvalue()))

    header = struct.pack("<HHH", 0, 1, len(payloads))
    offset = 6 + 16 * len(payloads)
    entries = b""
    data = b""
    for s, blob in payloads:
        dim = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        data += blob

    with open(path, "wb") as f:
        f.write(header + entries + data)


def save_maskable(path, master, canvas_size=512, content_ratio=0.8, feather=12):
    """自适应图标：内容缩进安全区，底色取图案边缘中位色并羽化，避免方形接缝"""
    inner_size = int(canvas_size * content_ratio)
    inner = master.resize((inner_size, inner_size), Image.LANCZOS)

    edge = []
    for x in range(inner_size):
        edge.append(inner.getpixel((x, 0)))
        edge.append(inner.getpixel((x, inner_size - 1)))
    for y in range(inner_size):
        edge.append(inner.getpixel((0, y)))
        edge.append(inner.getpixel((inner_size - 1, y)))
    bg = tuple(sorted(p[c] for p in edge)[len(edge) // 2] for c in range(3))

    canvas = Image.new("RGB", (canvas_size, canvas_size), bg)
    mask = Image.new("L", (inner_size, inner_size), 255)
    d = ImageDraw.Draw(mask)
    for i in range(feather):
        d.rectangle([i, i, inner_size - 1 - i, inner_size - 1 - i],
                    outline=int(255 * (i + 1) / (feather + 1)))
    canvas.paste(inner, ((canvas_size - inner_size) // 2, (canvas_size - inner_size) // 2), mask)
    canvas.save(path, "PNG", optimize=True)
    return bg
