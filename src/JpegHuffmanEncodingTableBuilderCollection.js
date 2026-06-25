// Collection of Huffman table builders keyed by (class, identifier), used while
// gathering symbol statistics. Port of JpegHuffmanEncodingTableBuilderCollection.cs.
import { JpegHuffmanEncodingTableBuilder } from './JpegHuffmanEncodingTableBuilder.js';
import { JpegHuffmanEncodingTableCollection } from './JpegHuffmanEncodingTableCollection.js';

export class JpegHuffmanEncodingTableBuilderCollection {
  constructor() {
    /** @type {{tableClass:number, identifier:number, builder:JpegHuffmanEncodingTableBuilder}[]|null} */
    this._builders = null;
  }

  getOrCreateTableBuilder(isDcTable, identifier) {
    const tableClass = isDcTable ? 0 : 1;
    if (this._builders === null) this._builders = [];
    for (const b of this._builders) {
      if (b.tableClass === tableClass && b.identifier === identifier) return b.builder;
    }
    const builder = new JpegHuffmanEncodingTableBuilder();
    this._builders.push({ tableClass, identifier, builder });
    return builder;
  }

  buildTables(optimal = false) {
    const collection = new JpegHuffmanEncodingTableCollection();
    if (this._builders === null) return collection;
    for (const b of this._builders) {
      collection.addTable(b.tableClass, b.identifier, b.builder.build(optimal));
    }
    return collection;
  }
}
