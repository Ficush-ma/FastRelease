'use strict';

/**
 * 极简 ZIP 写入器（只用 Node 自带 zlib，无第三方依赖）。
 * 只支持普通文件、deflate 压缩、单卷、无加密 —— 够打包 Electron 目录用。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, rel, out);
    else out.push({ full, rel, mtime: st.mtime, size: st.size });
  }
}

/**
 * @param {string} srcDir 要压缩的目录
 * @param {string} outFile 输出 zip 路径
 * @param {(done:number,total:number)=>void} [onProgress]
 */
function zipDirectory(srcDir, outFile, onProgress) {
  const files = [];
  walk(srcDir, '', files);

  const fd = fs.openSync(outFile, 'w');
  const central = [];
  let offset = 0;

  const write = (buf) => {
    fs.writeSync(fd, buf, 0, buf.length);
    offset += buf.length;
  };

  files.forEach((f, i) => {
    const raw = fs.readFileSync(f.full);
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    // 压不小就直接存原始数据
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const dt = dosDateTime(f.mtime);
    const nameBuf = Buffer.from(f.rel, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const headerOffset = offset;
    write(local);
    write(nameBuf);
    write(data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dt.time, 12);
    cd.writeUInt16LE(dt.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(headerOffset, 42);

    central.push(Buffer.concat([cd, nameBuf]));
    if (onProgress) onProgress(i + 1, files.length);
  });

  const cdStart = offset;
  for (const buf of central) write(buf);
  const cdSize = offset - cdStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  write(eocd);

  fs.closeSync(fd);
  return { files: files.length, size: offset };
}

module.exports = { zipDirectory };

if (require.main === module) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('用法: node scripts/zip.js <目录> <输出.zip>');
    process.exit(1);
  }
  const t0 = Date.now();
  const res = zipDirectory(path.resolve(src), path.resolve(out), (done, total) => {
    if (done % 10 === 0 || done === total) process.stdout.write(`\r  压缩中 ${done}/${total}`);
  });
  console.log(`\n完成：${res.files} 个文件，${(res.size / 1024 / 1024).toFixed(1)} MB，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
