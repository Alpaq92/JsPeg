// Builds a Huffman encoding table from symbol frequencies.
// Port of JpegHuffmanEncodingTableBuilder.cs (both the ITU-T81 Annex K standard
// method and the package-merge "optimal" method).
import { JpegHuffmanEncodingTable, assignCanonicalCodes } from './JpegHuffmanEncodingTable.js';

export class JpegHuffmanEncodingTableBuilder {
  constructor() {
    this._frequencies = new Uint32Array(256);
  }

  incrementCodeCount(symbol) {
    this._frequencies[symbol]++;
  }

  reset() {
    this._frequencies.fill(0);
  }

  /** @param {boolean} optimal */
  build(optimal = false) {
    return optimal ? this._buildUsingPackageMerge() : this._buildUsingStandardMethod();
  }

  // ---- Standard method (ITU-T81 Annex K) ---------------------------------

  _buildUsingStandardMethod() {
    const frequencies = this._frequencies;
    let codeCount = 0;
    for (let i = 0; i < frequencies.length; i++) if (frequencies[i] > 0) codeCount++;
    if (codeCount === 0) throw new Error('No symbol is recorded.');

    // symbols + one reserved sentinel (so the all-ones code is never assigned)
    const symbols = new Array(codeCount + 1);
    let index = 0;
    for (let i = 0; i < frequencies.length; i++) {
      if (frequencies[i] !== 0) {
        symbols[index++] = { frequency: frequencies[i], value: i, codeSize: 0, others: -1 };
      }
    }
    symbols[index] = { frequency: 1, value: -1, codeSize: 0, others: -1 };

    findHuffmanCodeSize(symbols);

    // count codes of each size
    const bits = new Int32Array(60);
    index = 32;
    for (let i = 0; i < symbols.length; i++) {
      const codeSize = symbols[i].codeSize;
      if (codeSize > 0) {
        index = Math.max(index, codeSize);
        bits[codeSize - 1]++;
      }
    }

    // limit code lengths to 16 bits (Annex K.3)
    for (;;) {
      while (bits[index] > 0) {
        let j = index - 1;
        do {
          j -= 1;
        } while (bits[j] === 0);
        bits[index] -= 2;
        bits[index - 1] += 1;
        bits[j + 1] += 2;
        bits[j] -= 1;
      }
      index -= 1;
      if (index !== 15) continue;
      while (bits[index] === 0) index--;
      bits[index]--;
      break;
    }

    // move the reserved sentinel to the end, then sort by code size
    for (let i = 0; i < symbols.length; i++) {
      if (symbols[i].value === -1) symbols[i].codeSize = 0xffff;
    }
    symbols.sort((a, b) => a.codeSize - b.codeSize);

    const codes = buildCanonicalCodeFromBits(bits, symbols, codeCount);
    return new JpegHuffmanEncodingTable(codes);
  }

  // ---- Package-merge optimal method --------------------------------------

  _buildUsingPackageMerge() {
    const frequencies = this._frequencies;
    let codeCount = 0;
    for (let i = 0; i < frequencies.length; i++) if (frequencies[i] > 0) codeCount++;

    const symbols = new Array(codeCount + 1);
    let index = 0;
    for (let i = 0; i < frequencies.length; i++) {
      if (frequencies[i] !== 0) {
        symbols[index++] = { frequency: frequencies[i], value: i, codeSize: 0, others: -1 };
      }
    }
    symbols[index] = { frequency: 0, value: -1, codeSize: 0, others: -1 };

    runPackageMerge(symbols);

    // sort by (codeSize asc, frequency desc)
    symbols.sort((x, y) => {
      if (x.codeSize !== y.codeSize) return x.codeSize - y.codeSize;
      return y.frequency - x.frequency;
    });

    // remove the reserved sentinel
    let sentinel = 0;
    for (let i = symbols.length - 1; i >= 0; i--) {
      if (symbols[i].value === -1) {
        sentinel = i;
        break;
      }
    }
    for (let i = sentinel; i < symbols.length - 1; i++) symbols[i] = symbols[i + 1];

    const codes = new Array(codeCount);
    for (let i = 0; i < codeCount; i++) {
      codes[i] = { code: 0, symbol: symbols[i].value & 0xff, codeLength: symbols[i].codeSize };
    }
    assignCanonicalCodes(codes);
    return new JpegHuffmanEncodingTable(codes);
  }
}

function findHuffmanCodeSize(symbols) {
  for (;;) {
    let v1 = -1;
    let v2 = -1;
    let v1f = -1;
    let v2f = -1;

    for (let i = 0; i < symbols.length; i++) {
      const f = symbols[i].frequency;
      if (f >= 0 && (v1 === -1 || f < v1f)) {
        v1 = i;
        v1f = f;
      }
    }
    for (let i = 0; i < symbols.length; i++) {
      const f = symbols[i].frequency;
      if (f >= 0 && i !== v1 && (v2 === -1 || f < v2f)) {
        v2 = i;
        v2f = f;
      }
    }
    if (v2 === -1) break;

    symbols[v1].frequency += symbols[v2].frequency;
    symbols[v2].frequency = -1;

    symbols[v1].codeSize++;
    while (symbols[v1].others !== -1) {
      v1 = symbols[v1].others;
      symbols[v1].codeSize++;
    }
    symbols[v1].others = v2;

    symbols[v2].codeSize++;
    while (symbols[v2].others !== -1) {
      v2 = symbols[v2].others;
      symbols[v2].codeSize++;
    }
  }
}

function buildCanonicalCodeFromBits(bits, symbols, codeCount) {
  const codes = new Array(codeCount);
  let currentCodeLength = 1;
  let li = 0;
  for (let i = 0; i < codeCount; i++) {
    while (bits[li] === 0) {
      li++;
      currentCodeLength++;
    }
    bits[li]--;
    codes[i] = { code: 0, symbol: symbols[i].value & 0xff, codeLength: currentCodeLength };
  }
  return assignCanonicalCodes(codes);
}

// ---- package merge internals ----------------------------------------------

class Node {
  constructor() {
    this.frequency = 0;
    this.index = 0;
    this.left = null;
    this.right = null;
  }

  setLeaf(index, frequency) {
    this.index = index;
    this.frequency = frequency;
  }

  setPackage(left, right) {
    this.frequency = left.frequency + right.frequency;
    this.left = left;
    this.right = right;
  }
}

function runPackageMerge(symbols) {
  symbols.sort((x, y) => y.frequency - x.frequency); // descending
  const codeCount = symbols.length;

  const levels = new Array(16);
  for (let l = 15; l >= 0; l--) {
    const nodes = [];
    for (let i = 0; i < codeCount; i++) {
      const node = new Node();
      node.setLeaf(i, symbols[i].frequency);
      nodes.push(node);
    }
    levels[l] = nodes;
  }

  for (let l = 15; l > 0; l--) {
    const nodes = levels[l];
    const nextLevelNodes = levels[l - 1];
    nodes.sort((x, y) => y.frequency - x.frequency); // descending
    for (let nodeCount = nodes.length; nodeCount >= 2; nodeCount = nodes.length) {
      const node1 = nodes[nodeCount - 1];
      const node2 = nodes[nodeCount - 2];
      nodes.length -= 2;
      const node = new Node();
      node.setPackage(node1, node2);
      nextLevelNodes.push(node);
    }
  }

  const level0 = levels[0];
  level0.sort((x, y) => x.frequency - y.frequency); // ascending
  const selectCount = Math.max(1, 2 * (codeCount - 1));
  for (let i = 0; i < selectCount; i++) {
    traverseNode(level0[i], symbols);
  }
}

function traverseNode(node, symbols) {
  if (node == null) return;
  if (node.left == null) {
    symbols[node.index].codeSize++;
  } else {
    traverseNode(node.left, symbols);
    traverseNode(node.right, symbols);
  }
}
