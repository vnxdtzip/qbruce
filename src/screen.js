/* screen.js — decode Bruce's TFT serial protocol (tftLogger) onto a <canvas>.
 * Packet layout per op:  0xAA | size | fn | <args...>  (size = full packet length)
 *
 * The protocol is VECTOR draw commands (rects, lines, circles, text), not a
 * bitmap, so we render them at a supersampled resolution (device res x SCALE)
 * via a context transform. Shapes and text come out crisp/HD instead of a
 * blocky upscale of a tiny framebuffer. fn/key map must match firmware
 * include/tftLogger.h (enum tftFuncs). */
const RENDER_SCALE = 4;

class ScreenRenderer {
  constructor(canvas, scale = RENDER_SCALE) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = scale;
    this.devW = 240; this.devH = 135;      // defaults until the first SCREEN_INFO packet
    this._resize(this.devW, this.devH);
  }

  _applyTransform() { this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0); this.ctx.imageSmoothingEnabled = true; }

  static color565toCss(c) {
    const r = ((c >> 11) & 0x1f) * (255 / 31);
    const g = ((c >> 5) & 0x3f) * (255 / 63);
    const b = (c & 0x1f) * (255 / 31);
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  _resize(w, h) {
    this.devW = w; this.devH = h;
    const needW = w * this.scale, needH = h * this.scale;
    if (this.canvas.width !== needW || this.canvas.height !== needH) {
      this.canvas.width = needW; this.canvas.height = needH;   // this resets the ctx
    }
    this._applyTransform();
  }

  /* Render a 0xAA packet (or a concatenation of packets) in device coordinates;
   * the active transform scales everything up to the HD backing store. */
  render(data) {
    const ctx = this.ctx;
    if (!ctx) return;
    this._applyTransform();                 // ensure HD transform is active
    let pos = 0;
    const readU8  = () => data[pos++];
    const readU16 = () => { const v = (data[pos] << 8) | data[pos + 1]; pos += 2; return v; };

    const keysMap = {
      0:['fg'], 1:['x','y','w','h','fg'], 2:['x','y','w','h','fg'],
      3:['x','y','w','h','r','fg'], 4:['x','y','w','h','r','fg'],
      5:['x','y','r','fg'], 6:['x','y','r','fg'],
      7:['x','y','x2','y2','x3','y3','fg'], 8:['x','y','x2','y2','x3','y3','fg'],
      9:['x','y','rx','ry','fg'], 10:['x','y','rx','ry','fg'],
      11:['x','y','x1','y1','fg'], 12:['x','y','r','ir','startAngle','endAngle','fg','bg'],
      13:['x','y','bx','by','wd','fg','bg'],
      14:['x','y','size','fg','bg','txt'], 15:['x','y','size','fg','bg','txt'],
      16:['x','y','size','fg','bg','txt'], 17:['x','y','size','fg','bg','txt'],
      18:['x','y','center','ms','fs','file'], 19:['x','y','fg'],
      20:['x','y','h','fg'], 21:['x','y','w','fg'], 99:['w','h','rotation'],
    };

    while (pos < data.length) {
      if (data[pos] !== 0xaa) break;
      const start = pos;
      pos++;                       // 0xAA
      const size = readU8();       // size
      const fn = readU8();         // function id
      const next = start + size;
      const input = {};
      let left = size - 3;
      for (const key of (keysMap[fn] || [])) {
        if (key === 'txt' || key === 'file') { input[key] = decodeStr(data, pos, left); pos += left; left = 0; }
        else if (key === 'rotation' || key === 'fs') { const v = readU8(); left -= 1; input[key] = (key === 'fs') ? (v === 0 ? 'SD' : 'FS') : v; }
        else { input[key] = readU16(); left -= 2; }
      }
      pos = next;                  // always advance exactly size bytes

      ctx.lineWidth = 1; ctx.fillStyle = 'black'; ctx.strokeStyle = 'black';
      const C = ScreenRenderer.color565toCss;
      switch (fn) {
        case 99:
          if (input.w && input.h) this._resize(input.w, input.h);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, this.devW, this.devH); break;
        case 0:
          ctx.fillStyle = C(input.fg || 0);
          ctx.fillRect(0, 0, this.devW, this.devH); break;
        case 1: ctx.strokeStyle = C(input.fg); ctx.strokeRect(input.x, input.y, input.w, input.h); break;
        case 2: ctx.fillStyle = C(input.fg); ctx.fillRect(input.x, input.y, input.w, input.h); break;
        case 3: ctx.strokeStyle = C(input.fg); roundRect(ctx, input, false); break;
        case 4: ctx.fillStyle = C(input.fg); roundRect(ctx, input, true); break;
        case 5: ctx.strokeStyle = C(input.fg); ctx.beginPath(); ctx.arc(input.x, input.y, input.r, 0, 7); ctx.stroke(); break;
        case 6: ctx.fillStyle = C(input.fg); ctx.beginPath(); ctx.arc(input.x, input.y, input.r, 0, 7); ctx.fill(); break;
        case 7: ctx.strokeStyle = C(input.fg); tri(ctx, input); ctx.stroke(); break;
        case 8: ctx.fillStyle = C(input.fg); tri(ctx, input); ctx.fill(); break;
        case 9: ctx.strokeStyle = C(input.fg); ctx.beginPath(); ctx.ellipse(input.x, input.y, input.rx, input.ry, 0, 0, 7); ctx.stroke(); break;
        case 10: ctx.fillStyle = C(input.fg); ctx.beginPath(); ctx.ellipse(input.x, input.y, input.rx, input.ry, 0, 0, 7); ctx.fill(); break;
        case 11: ctx.strokeStyle = C(input.fg); ctx.beginPath(); ctx.moveTo(input.x, input.y); ctx.lineTo(input.x1, input.y1); ctx.stroke(); break;
        case 12: {
          ctx.strokeStyle = C(input.fg);
          const radius = (input.r + input.ir) / 2;
          ctx.lineWidth = (input.r - input.ir) || 1;
          const sa = ((input.startAngle + 90) || 0) * Math.PI / 180;
          const ea = ((input.endAngle + 90) || 0) * Math.PI / 180;
          ctx.beginPath(); ctx.arc(input.x, input.y, radius, sa, ea); ctx.stroke(); break;
        }
        case 13: ctx.strokeStyle = C(input.fg); ctx.lineWidth = input.wd || 1; ctx.beginPath(); ctx.moveTo(input.x, input.y); ctx.lineTo(input.bx, input.by); ctx.stroke(); break;
        case 14: case 15: case 16: case 17: {
          if (input.bg === input.fg) input.bg = 0;
          const text = String(input.txt ?? '').replaceAll('\n', '');
          const fontW = input.size * 6;             // device px per glyph (approx)
          let offX = 0;
          if (fn === 15) offX = text.length * fontW;
          if (fn === 14) offX = (text.length * fontW) / 2;
          ctx.fillStyle = C(input.bg);
          ctx.fillRect(input.x - offX, input.y, text.length * fontW, input.size * 8);
          ctx.fillStyle = C(input.fg);
          ctx.font = `${input.size * 8}px "ShareTechMono", "JetBrains Mono", monospace`;
          ctx.textBaseline = 'top';
          ctx.textAlign = fn === 14 ? 'center' : fn === 15 ? 'right' : 'left';
          ctx.fillText(text, input.x, input.y); break;
        }
        case 18: break;   // images not rendered over serial
        case 19: ctx.fillStyle = C(input.fg); ctx.fillRect(input.x, input.y, 1, 1); break;
        case 20: ctx.fillStyle = C(input.fg); ctx.fillRect(input.x, input.y, 1, input.h); break;
        case 21: ctx.fillStyle = C(input.fg); ctx.fillRect(input.x, input.y, input.w, 1); break;
      }
    }
  }

  /* parse a "display dump" hex blob (between "Binary Dump:" and "[End of Dump]") */
  static parseDump(text) {
    const startIdx = text.indexOf('AA');
    let cleaned = startIdx >= 0 ? text.slice(startIdx) : text;
    cleaned = cleaned.replace(/\[End of Dump\][\s\S]*$/i, '');
    const hex = cleaned.replace(/[^0-9A-Fa-f]/g, '');
    const even = hex.length & ~1;
    const arr = new Uint8Array(even / 2);
    for (let i = 0, j = 0; i < even; i += 2, j++) arr[j] = parseInt(hex.substr(i, 2), 16);
    return arr;
  }
}

function decodeStr(data, pos, len) { return new TextDecoder().decode(data.slice(pos, pos + len)); }
function roundRect(ctx, { x, y, w, h, r }, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  fill ? ctx.fill() : ctx.stroke();
}
function tri(ctx, i) { ctx.beginPath(); ctx.moveTo(i.x, i.y); ctx.lineTo(i.x2, i.y2); ctx.lineTo(i.x3, i.y3); ctx.closePath(); }

window.ScreenRenderer = ScreenRenderer;
