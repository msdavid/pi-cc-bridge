#!/usr/bin/env python3
"""Render a tmux `capture-pane -e` ANSI capture as a PNG via headless Chrome.
Usage: ansi2png.py capture.ansi out.png [width] [title]
"""
import html, json, sys, base64

FG = {30: "#666666", 31: "#f87171", 32: "#4ade80", 33: "#fbbf24", 34: "#60a5fa", 35: "#c084fc", 36: "#2dd4bf", 37: "#d4d4d4",
      90: "#737373", 91: "#fca5a5", 92: "#86efac", 93: "#fde047", 94: "#93c5fd", 95: "#d8b4fe", 96: "#5eead4", 97: "#ffffff"}
BG = {40: "#1a1a1a", 41: "#7f1d1d", 42: "#14532d", 43: "#78350f", 44: "#1e3a5f", 45: "#4c1d95", 46: "#134e4a", 47: "#333333",
      100: "#333333", 101: "#7f1d1d", 102: "#14532d", 103: "#78350f", 104: "#1e3a5f", 105: "#4c1d95", 106: "#134e4a", 107: "#e5e5e5"}
X256 = lambda n: f"#{[0,0,0][0]:02x}" if False else None

def x256_color(n):
    if n < 16:
        base = ["#000000","#800000","#008000","#808000","#000080","#800080","#008080","#c0c0c0",
                "#808080","#ff0000","#00ff00","#ffff00","#0000ff","#ff00ff","#00ffff","#ffffff"]
        return base[n]
    if n < 232:
        i = n - 16; steps = [0, 95, 135, 175, 215, 255]
        r, g, b = (i // 36) % 6, (i // 6) % 6, i % 6
        return f"#{steps[r]:02x}{steps[g]:02x}{steps[b]:02x}"
    v = 8 + (n - 232) * 10
    return f"#{v:02x}{v:02x}{v:02x}"

def ansi_to_html(data: str) -> str:
    out, i, bold, fg, bg = [], 0, False, None, None
    buf = []
    def flush():
        if buf:
            style = []
            if bold: style.append("font-weight:bold")
            if fg: style.append(f"color:{fg}")
            if bg: style.append(f"background:{bg}")
            st = f' style="{";".join(style)}"' if style else ""
            out.append(f'<span{st}>{html.escape("".join(buf))}</span>')
            buf.clear()
    while i < len(data):
        ch = data[i]
        if ch == "\x1b" and i + 1 < len(data) and data[i + 1] == "[":
            j = i + 2
            while j < len(data) and not data[j].isalpha() and data[j] not in "m":
                j += 1
            if j < len(data) and data[j] == "m":
                flush()
                params = data[i + 2:j]
                codes = [int(p) if p else 0 for p in params.split(";")] if params else [0]
                k = 0
                while k < len(codes):
                    c = codes[k]
                    if c == 0: bold, fg, bg = False, None, None
                    elif c == 1: bold = True
                    elif c == 22: bold = False
                    elif 30 <= c <= 37: fg = FG.get(c)
                    elif c == 39: fg = None
                    elif 90 <= c <= 97: fg = FG.get(c)
                    elif 40 <= c <= 47: bg = BG.get(c)
                    elif c == 49: bg = None
                    elif c in (38, 48):
                        if k + 1 < len(codes):
                            if codes[k + 1] == 5 and k + 2 < len(codes):
                                col = x256_color(codes[k + 2]); k += 2
                            elif codes[k + 1] == 2 and k + 4 < len(codes):
                                col = f"#{codes[k+2]:02x}{codes[k+3]:02x}{codes[k+4]:02x}"; k += 4
                            else:
                                col = None; k += 1
                            if c == 38: fg = col
                            else: bg = col
                    k += 1
                i = j + 1
                continue
            # other escapes (cursor etc.): skip to terminating letter
            i = j + 1
            continue
        if ch == "\r":
            i += 1; continue
        buf.append(ch)
        i += 1
    flush()
    return "".join(out)

def main():
    src, out_png = sys.argv[1], sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
    title = sys.argv[4] if len(sys.argv) > 4 else ""
    data = open(src, encoding="utf-8", errors="replace").read()
    body = ansi_to_html(data)
    page = f"""<!doctype html><html><head><meta charset="utf-8"><style>
body {{ background:#0d1117; margin:0; padding:24px; }}
pre {{ font-family:'JetBrains Mono','Fira Code',monospace; font-size:15px; line-height:1.35;
      color:#d4d4d4; white-space:pre; }}
.title {{ color:#8b949e; font-family:sans-serif; font-size:13px; margin-bottom:10px; }}
</style></head><body><div class="title">{html.escape(title)}</div><pre>{body}</pre></body></html>"""
    htmlfile = out_png.replace(".png", ".html")
    open(htmlfile, "w").write(page)
    print(htmlfile)

main()
