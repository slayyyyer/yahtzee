'use strict';

const fs = require('fs');
const path = require('path');

const TABLE_SIZE = 1048576;

/**
 * Read the generated Float32 table, or return null when it has not been built.
 * Throws if the file exists but has the wrong size.
 */
function loadOptimalTable(file) {
  const target = file || path.join(__dirname, 'optimal-table.bin');
  if (!fs.existsSync(target)) return null;

  const buf = fs.readFileSync(target);
  const expected = TABLE_SIZE * 4;
  if (buf.length !== expected) {
    throw new Error('Optimal table has ' + buf.length + ' bytes; expected ' + expected + '.');
  }

  const bytes = new Uint8Array(buf.length);
  bytes.set(buf);
  return new Float32Array(bytes.buffer, 0, TABLE_SIZE);
}

module.exports = { loadOptimalTable };
