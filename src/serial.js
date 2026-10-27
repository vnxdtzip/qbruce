/* serial.js — single shared Web Serial connection to a Bruce device.
 *
 * One persistent reader demultiplexes the byte stream:
 *   - 0xAA-framed packets  -> screen renderer (TFT async-serial / display dump)
 *   - everything else      -> text (CLI echo, command output, prompt "# ")
 *
 * Bruce's serial task answers nav/options/optionsJSON and one-shot CLI commands
 * quickly (it only sets flags or prints), while blocking attack loops run on the
 * device's main UI loop. So we expose:
 *   - sendCommand()  : one-shot command, resolves on the "# " prompt or silence
 *   - writeLine()    : fire a raw line (nav/options) without waiting
 *   - optionsJSON()  : read the live on-device menu
 *   - menuSelect()   : pick an option by index on the current menu
 *   - sendYmodem()   : push a binary file via the firmware's YMODEM receiver
 */
class SerialManager {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;
    this.baud = 115200;

    this.rx = new Uint8Array(0);           // pending raw bytes
    this.decoder = new TextDecoder();
    this.capture = null;                   // active one-shot capture {buffer,...}
    this._writeLock = Promise.resolve();   // serialize writers

    // subscribers
    this.onText = [];      // (chunk:string) => void   raw text, for terminal
    this.onPacket = [];     // (Uint8Array) => void     0xAA screen packets
    this.onStatus = [];     // (connected:bool) => void
  }

  /* ---- subscription helpers ---- */
  subText(fn)   { this.onText.push(fn); }
  subPacket(fn) { this.onPacket.push(fn); }
  subStatus(fn) { this.onStatus.push(fn); }
  _emitText(s)  { for (const f of this.onText) try { f(s); } catch (e) { console.error(e); } }
  _emitPacket(p){ for (const f of this.onPacket) try { f(p); } catch (e) { console.error(e); } }
  _emitStatus() { for (const f of this.onStatus) try { f(this.connected); } catch (e) {} }

  async connect(baud = 115200) {
    if (!('serial' in navigator)) throw new Error('Web Serial not supported. Use Chrome or Edge.');
    this.baud = baud;
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: baud, bufferSize: 8192 });
    this.writer = this.port.writable.getWriter();
    this.connected = true;
    this._emitStatus();
    this._readLoop();           // fire and forget
    return true;
  }

  async disconnect() {
    this.connected = false;
    try { if (this.reader) { await this.reader.cancel(); } } catch {}
    try { if (this.writer) { this.writer.releaseLock(); this.writer = null; } } catch {}
    try { if (this.port) { await this.port.close(); } } catch {}
    this.port = null; this.reader = null;
    this._emitStatus();
  }

  async _readLoop() {
    while (this.connected && this.port && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) this._feed(value);
        }
      } catch (e) {
        if (this.connected) console.warn('read error', e);
      } finally {
        try { this.reader.releaseLock(); } catch {}
      }
      if (!this.connected) break;
    }
  }

  /* demultiplex incoming bytes */
  _feed(chunk) {
    // append
    const merged = new Uint8Array(this.rx.length + chunk.length);
    merged.set(this.rx, 0); merged.set(chunk, this.rx.length);
    this.rx = merged;

    while (this.rx.length) {
      if (this.rx[0] === 0xaa) {
        if (this.rx.length < 2) break;            // need size byte
        const size = this.rx[1];
        if (size < 3) {                            // malformed frame, drop the header byte
          this.rx = this.rx.slice(1);
          continue;
        }
        if (this.rx.length < size) break;          // wait for full packet
        const packet = this.rx.slice(0, size);
        this.rx = this.rx.slice(size);
        this._emitPacket(packet);
        continue;
      }
      // text run up to the next 0xAA
      const nextIdx = this.rx.indexOf(0xaa);
      let textBytes;
      if (nextIdx === -1) { textBytes = this.rx; this.rx = new Uint8Array(0); }
      else { textBytes = this.rx.slice(0, nextIdx); this.rx = this.rx.slice(nextIdx); }
      const text = this.decoder.decode(textBytes, { stream: true });
      if (text) this._handleText(text);
      if (nextIdx === -1) break;
    }
  }

  _handleText(text) {
    this._emitText(text);
    if (this.capture) {
      this.capture.buffer += text;
      this.capture.last = performance.now();
    }
  }

  async _write(str) {
    const bytes = new TextEncoder().encode(str);
    // chain on the lock so concurrent callers don't interleave
    const run = this._writeLock.then(async () => {
      if (!this.writer) throw new Error('Not connected');
      await this.writer.write(bytes);
    });
    this._writeLock = run.catch(() => {});
    return run;
  }
  async writeRaw(bytes) {
    const run = this._writeLock.then(async () => {
      if (!this.writer) throw new Error('Not connected');
      await this.writer.write(bytes);
    });
    this._writeLock = run.catch(() => {});
    return run;
  }

  /* Fire a line and don't wait for output (nav / options / fast setters). */
  async writeLine(line) { await this._write(line.endsWith('\n') ? line : line + '\n'); }

  /* One-shot command. Resolves when the "# " prompt returns, or after `silence`
   * ms of no new bytes, or after `timeout` ms hard cap. Returns cleaned output. */
  async sendCommand(cmd, { timeout = 9000, silence = 650 } = {}) {
    if (!this.connected) throw new Error('Not connected');
    // wait for any previous capture to finish
    while (this.capture) await sleep(20);

    const cap = { buffer: '', last: performance.now(), cmd };
    this.capture = cap;
    await this._write(cmd + '\n');

    const start = performance.now();
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        const now = performance.now();
        const buf = cap.buffer;
        const promptSeen = /\n#\s*$/.test(buf) || /(^|\n)#\s*$/.test(buf.trimEnd() + '\n');
        const quiet = (now - cap.last) > silence && buf.length > 0;
        const expired = (now - start) > timeout;
        if (promptSeen || quiet || expired) {
          clearInterval(tick);
          this.capture = null;
          resolve(cleanOutput(buf, cmd));
        }
      }, 40);
    });
  }

  /* Read the live on-device menu as an object (optionsJSON). */
  async optionsJSON() {
    const raw = await this.sendCommand('optionsJSON', { silence: 450, timeout: 4000 });
    const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('No menu JSON in response');
    return JSON.parse(raw.slice(s, e + 1));
  }

  /* Select option by index on the current menu (sets forceMenuOption). */
  async menuSelect(index) { await this.writeLine('options ' + index); }

  /* Navigation press. dir: up/down/next/prev/sel/esc/nextpage/prevpage */
  async nav(dir, duration = 1) { await this.writeLine(`nav ${dir} ${duration}`); }

  /* -------- YMODEM send (push a binary file into the device) --------
   * Mirrors the firmware receiver: 128-byte SOH blocks, CRC16-CCITT (init 0x0000),
   * block 0 carries "filename\0size\0", final EOT. */
  async sendYmodem(path, data, onProgress) {
    const name = path.split('/').pop();
    await this.sendCommand(`storage ymodem "${path}"`, { silence: 300, timeout: 2500 });
    // wait for the device to start sending 'C' (CRC requests)
    await this._ymodemWaitByte([0x43], 15000);

    // block 0: filename + size
    const header = new TextEncoder().encode(name + '\0' + data.length + '\0');
    await this._ymodemSendBlock(0, header);
    if (!(await this._ymodemWaitByte([0x06], 4000))) throw new Error('No ACK for header');
    await this._ymodemWaitByte([0x43], 4000); // next 'C'

    // data blocks
    let block = 1, offset = 0;
    const total = data.length;
    while (offset < total) {
      const slice = data.slice(offset, offset + 128);
      if (!(await this._ymodemSendBlockWithRetry(block & 0xff, slice))) throw new Error(`Block ${block} failed`);
      offset += 128; block++;
      if (onProgress) onProgress(Math.min(offset, total), total);
    }
    // EOT
    await this.writeRaw(new Uint8Array([0x04]));
    await this._ymodemWaitByte([0x06], 4000);
    return true;
  }

  _ymodemCrc16(buf) {
    let crc = 0x0000;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i] << 8;
      for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc & 0xffff;
  }
  async _ymodemSendBlock(num, payload) {
    const data = new Uint8Array(128).fill(0x1a);     // pad with 0x1A
    data.set(payload.slice(0, 128));
    const crc = this._ymodemCrc16(data);
    const pkt = new Uint8Array(3 + 128 + 2);
    pkt[0] = 0x01; pkt[1] = num & 0xff; pkt[2] = (~num) & 0xff;
    pkt.set(data, 3);
    pkt[131] = (crc >> 8) & 0xff; pkt[132] = crc & 0xff;
    await this.writeRaw(pkt);
  }
  async _ymodemSendBlockWithRetry(num, payload, retries = 4) {
    for (let r = 0; r < retries; r++) {
      await this._ymodemSendBlock(num, payload);
      if (await this._ymodemWaitByte([0x06], 3000)) return true;   // ACK
    }
    return false;
  }
  /* Watch the raw text/byte stream for a control byte. We piggy-back on capture. */
  _ymodemWaitByte(targets, timeout) {
    return new Promise((resolve) => {
      const cap = { buffer: '', last: performance.now(), ym: targets };
      this.capture = cap;
      const start = performance.now();
      const tick = setInterval(() => {
        for (let i = 0; i < cap.buffer.length; i++) {
          if (targets.includes(cap.buffer.charCodeAt(i))) {
            clearInterval(tick); this.capture = null; return resolve(true);
          }
        }
        if (performance.now() - start > timeout) { clearInterval(tick); this.capture = null; resolve(false); }
      }, 25);
    });
  }
}

/* strip the "COMMAND: <cmd>" echo, the trailing "# " prompt and [CLI] Result line */
function cleanOutput(buf, cmd) {
  let lines = buf.split('\n');
  lines = lines.filter(l => {
    const t = l.trim();
    if (t === '#' || t === '') return true;
    if (t.startsWith('COMMAND:')) return false;
    if (t.startsWith('[CLI] Result:')) return false;
    return true;
  });
  let out = lines.join('\n');
  out = out.replace(/\n?#\s*$/,'').replace(/^\s*\n/, '');
  return out.trim();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

window.SerialManager = SerialManager;
window.__sleep = sleep;
