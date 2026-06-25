// Collection of encoding tables (or builders awaiting optimization), keyed by
// (class, identifier). Port of JpegHuffmanEncodingTableCollection.cs.
import { JpegHuffmanEncodingTable } from './JpegHuffmanEncodingTable.js';
import { JpegHuffmanEncodingTableBuilder } from './JpegHuffmanEncodingTableBuilder.js';

export class JpegHuffmanEncodingTableCollection {
  constructor() {
    /** @type {{tableClass:number, identifier:number, table:object}[]|null} */
    this._tables = null;
  }

  get isEmpty() {
    return this._tables === null;
  }

  containsTableBuilder() {
    if (this._tables === null) return false;
    for (const t of this._tables) {
      if (t.table instanceof JpegHuffmanEncodingTableBuilder) return true;
    }
    return false;
  }

  deepClone() {
    const clone = new JpegHuffmanEncodingTableCollection();
    if (this._tables !== null) {
      clone._tables = this._tables.map((t) => ({ ...t }));
    }
    return clone;
  }

  getTable(isDcTable, identifier) {
    if (this._tables === null) return null;
    const tableClass = isDcTable ? 0 : 1;
    for (const t of this._tables) {
      if (t.tableClass === tableClass && t.identifier === identifier) {
        return t.table instanceof JpegHuffmanEncodingTable ? t.table : null;
      }
    }
    return null;
  }

  getTableBuilder(isDcTable, identifier) {
    if (this._tables === null) return null;
    const tableClass = isDcTable ? 0 : 1;
    for (const t of this._tables) {
      if (t.tableClass === tableClass && t.identifier === identifier) {
        return t.table instanceof JpegHuffmanEncodingTableBuilder ? t.table : null;
      }
    }
    return null;
  }

  addTable(tableClass, identifier, encodingTable) {
    if (this._tables === null) this._tables = [];
    for (const t of this._tables) {
      if (t.tableClass === tableClass && t.identifier === identifier) {
        throw new Error('Table with this class/identifier already exists.');
      }
    }
    const table = encodingTable == null ? new JpegHuffmanEncodingTableBuilder() : encodingTable;
    this._tables.push({ tableClass, identifier, table });
  }

  getTotalBytesRequired() {
    if (this._tables === null) throw new Error('No tables.');
    let bytesRequired = 0;
    for (const t of this._tables) {
      if (!(t.table instanceof JpegHuffmanEncodingTable)) throw new Error('Table not built.');
      bytesRequired += 1 + t.table.bytesRequired;
    }
    return bytesRequired;
  }

  /** Write all tables (each prefixed with a class/id byte) to the JpegWriter. */
  write(writer) {
    if (this._tables === null) throw new Error('No tables.');
    for (const t of this._tables) {
      if (!(t.table instanceof JpegHuffmanEncodingTable)) throw new Error('Table not built.');
      writer.writeByte(((t.tableClass << 4) | (t.identifier & 0xf)) & 0xff);
      const buf = new Uint8Array(t.table.bytesRequired);
      const n = t.table.write(buf, 0);
      writer.writeBytes(buf.subarray(0, n));
    }
  }

  buildTables(optimal) {
    if (this._tables === null) return;
    for (const t of this._tables) {
      if (t.table instanceof JpegHuffmanEncodingTableBuilder) {
        t.table = t.table.build(optimal);
      }
    }
  }
}
