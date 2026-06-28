// Progressive DCT Huffman scan encoder — the inverse of
// JpegHuffmanProgressiveScanDecoder. Given quantized coefficient blocks (in a
// JpegBlockAllocator, zig-zag order), it writes the progressive scans (DHT + SOS
// + entropy data) for a scan script.
//
// Every scan is NON-interleaved (a single component over its exact block grid),
// which mirrors the decoder's non-interleaved path for both DC (Ss=0) and AC
// (Ss>0) and avoids MCU edge-padding entirely.
//
// Both passes are supported: the first scan of a band (Ah=0) codes the
// point-transformed coefficients (spectral selection), and the refinement scans
// (Ah>0) code one lower bit-plane — DC as a raw bit per block, AC via the EOBn +
// correction-bit scheme (T.81 G.1.2.3). Each refinement path is the exact dual of
// JpegHuffmanProgressiveScanDecoder's, so the output round-trips bit-for-bit.
import { JpegMarker } from '../JpegMarker.js';
import { JpegScanHeader, JpegScanComponentSpecificationParameters } from '../JpegScanHeader.js';
import { JpegHuffmanEncodingTableBuilderCollection } from '../JpegHuffmanEncodingTableBuilderCollection.js';

const EOBRUN_MAX = 0x7fff;

/** Bits needed to hold a non-negative magnitude (JPEG "SSSS" category). */
function bitCount(magnitude) {
  return magnitude === 0 ? 0 : 32 - Math.clz32(magnitude);
}

/** AC point transform: divide by 2^Al toward zero (T.81 G.1.2.2). */
function pointTransformAC(coefficient, al) {
  if (al === 0) return coefficient;
  return coefficient >= 0 ? coefficient >> al : -((-coefficient) >> al);
}

/** Magnitude bits for a (point-transformed) coefficient value, per RECEIVE/EXTEND. */
function magnitudeBits(value, size) {
  return (value < 0 ? value - 1 : value) & ((1 << size) - 1);
}

/**
 * Write one progressive scan for a single component.
 * @param {object} scan { comp, ss, se, ah, al }
 */
export function writeProgressiveScan(writer, frameHeader, allocator, scan, mostOptimal) {
  const isDc = scan.ss === 0;
  const isRefine = scan.ah !== 0;
  const tableId = 0;

  // Refinement DC scans carry no Huffman symbols (raw correction bits only).
  const usesTable = !(isDc && isRefine);

  let table = null;
  if (usesTable) {
    const builders = new JpegHuffmanEncodingTableBuilderCollection();
    const builder = builders.getOrCreateTableBuilder(isDc, tableId);
    runScan(allocator, scan, makeGatherSink(builder));
    const tables = builders.buildTables(mostOptimal);
    table = tables.getTable(isDc, tableId);

    writer.writeMarker(JpegMarker.DefineHuffmanTable);
    writer.writeLength(tables.getTotalBytesRequired());
    tables.write(writer);
  }

  writeStartOfScan(writer, frameHeader, scan, isDc, tableId);

  writer.enterBitMode();
  runScan(allocator, scan, makeEmitSink(writer, table));
  writer.exitBitMode();
}

function writeStartOfScan(writer, frameHeader, scan, isDc, tableId) {
  const identifier = frameHeader.components[scan.comp].identifier;
  const scanComponent = new JpegScanComponentSpecificationParameters(
    identifier,
    isDc ? tableId : 0,
    isDc ? 0 : tableId,
  );
  const scanHeader = new JpegScanHeader(1, [scanComponent], scan.ss, scan.se, scan.ah, scan.al);
  writer.writeMarker(JpegMarker.StartOfScan);
  writer.writeLength(scanHeader.bytesRequired);
  const buf = new Uint8Array(scanHeader.bytesRequired);
  scanHeader.write(buf, 0);
  writer.writeBytes(buf);
}

// A "sink" abstracts the two passes: gather counts symbols to build the optimal
// table; emit writes the Huffman codes and magnitude bits.
function makeGatherSink(builder) {
  return { symbol: (s) => builder.incrementCodeCount(s), bits: () => {} };
}
function makeEmitSink(writer, table) {
  return {
    symbol: (s) => {
      table.getCode(s);
      writer.writeBits(table.code, table.codeLength);
    },
    bits: (value, n) => writer.writeBits(value, n),
  };
}

function runScan(allocator, scan, sink) {
  if (scan.ss === 0) {
    if (scan.ah === 0) runScanDC(allocator, scan, sink);
    else runScanDCRefine(allocator, scan, sink);
  } else {
    if (scan.ah === 0) runScanAC(allocator, scan, sink);
    else runScanACRefine(allocator, scan, sink);
  }
}

// DC refinement (Ah>0): one correction bit per block — bit `al` of the DC value.
// The decoder ORs it back in at position `al` (no Huffman symbols involved).
function runScanDCRefine(allocator, scan, sink) {
  const buffer = allocator.buffer;
  const info = allocator.componentInfo(scan.comp);
  const al = scan.al;
  for (let by = 0; by < info.vBlocks; by++) {
    for (let bx = 0; bx < info.hBlocks; bx++) {
      const off = allocator.getBlockOffset(scan.comp, bx, by);
      sink.bits((buffer[off] >> al) & 1, 1);
    }
  }
}

// AC refinement (Ah>0): the EOBn + correction-bit scheme (T.81 G.1.2.3), the
// exact dual of JpegHuffmanProgressiveScanDecoder._readBlockProgressiveACRefined.
// Newly-significant coefficients (|coef >> Al| === 1) are coded with a run/size
// symbol + sign; already-significant ones (|coef >> Al| > 1) only emit a
// correction bit (bit `al` of their magnitude). Correction bits buffered during a
// run are flushed right after the run's terminating symbol; those belonging to an
// end-of-band run stay buffered until the EOBn symbol is emitted.
function runScanACRefine(allocator, scan, sink) {
  const buffer = allocator.buffer;
  const info = allocator.componentInfo(scan.comp);
  const { ss, se, al } = scan;
  const absv = new Int32Array(64); // |point-transformed| value, reused per block
  let eobrun = 0;
  const corr = []; // correction bits owed to the pending end-of-band run

  const emitEob = () => {
    if (eobrun === 0) return;
    let nbits = 0;
    let temp = eobrun;
    while (temp > 1) {
      temp >>= 1;
      nbits++;
    }
    sink.symbol(nbits << 4);
    if (nbits > 0) sink.bits(eobrun & ((1 << nbits) - 1), nbits);
    for (let i = 0; i < corr.length; i++) sink.bits(corr[i], 1);
    corr.length = 0;
    eobrun = 0;
  };

  for (let by = 0; by < info.vBlocks; by++) {
    for (let bx = 0; bx < info.hBlocks; bx++) {
      const off = allocator.getBlockOffset(scan.comp, bx, by);

      let eob = 0; // index of the last newly-significant coefficient in this block
      for (let k = ss; k <= se; k++) {
        let t = buffer[off + k];
        if (t < 0) t = -t;
        t >>= al;
        absv[k] = t;
        if (t === 1) eob = k;
      }

      let run = 0; // run of newly-zero coefficients
      const br = []; // correction bits for already-significant coefs in this run

      for (let k = ss; k <= se; k++) {
        const t = absv[k];
        if (t === 0) {
          run++;
          continue;
        }

        // Break an over-long zero run with ZRL — but only while newly-significant
        // coefficients remain ahead; otherwise the tail folds into an EOB run.
        while (run > 15 && k <= eob) {
          emitEob();
          sink.symbol(0xf0); // ZRL
          for (let i = 0; i < br.length; i++) sink.bits(br[i], 1);
          br.length = 0;
          run -= 16;
        }

        if (t > 1) {
          br.push(t & 1); // already significant: buffer the correction bit
          continue;
        }

        // Newly significant: run/size symbol, sign bit, then the buffered bits.
        emitEob();
        sink.symbol((run << 4) | 1);
        sink.bits(buffer[off + k] < 0 ? 0 : 1, 1);
        for (let i = 0; i < br.length; i++) sink.bits(br[i], 1);
        br.length = 0;
        run = 0;
      }

      if (run > 0 || br.length > 0) {
        // The block ends in an end-of-band run; carry its correction bits along.
        eobrun++;
        for (let i = 0; i < br.length; i++) corr.push(br[i]);
        if (eobrun === EOBRUN_MAX) emitEob();
      }
    }
  }

  emitEob();
}

function runScanDC(allocator, scan, sink) {
  const buffer = allocator.buffer;
  const info = allocator.componentInfo(scan.comp);
  const al = scan.al;
  let predictor = 0;
  for (let by = 0; by < info.vBlocks; by++) {
    for (let bx = 0; bx < info.hBlocks; bx++) {
      const off = allocator.getBlockOffset(scan.comp, bx, by);
      const dc = buffer[off] >> al; // arithmetic point transform
      const diff = dc - predictor;
      predictor = dc;
      const size = bitCount(diff < 0 ? -diff : diff);
      sink.symbol(size); // DC: run is always 0, so symbol == magnitude category
      if (size > 0) sink.bits(magnitudeBits(diff, size), size);
    }
  }
}

function runScanAC(allocator, scan, sink) {
  const buffer = allocator.buffer;
  const info = allocator.componentInfo(scan.comp);
  const { ss, se, al } = scan;
  let eobrun = 0;

  for (let by = 0; by < info.vBlocks; by++) {
    for (let bx = 0; bx < info.hBlocks; bx++) {
      const off = allocator.getBlockOffset(scan.comp, bx, by);
      let run = 0; // run of zero coefficients

      for (let k = ss; k <= se; k++) {
        const v = pointTransformAC(buffer[off + k], al);
        if (v === 0) {
          run++;
          continue;
        }
        if (eobrun > 0) {
          emitEobrun(sink, eobrun);
          eobrun = 0;
        }
        while (run > 15) {
          sink.symbol(0xf0); // ZRL
          run -= 16;
        }
        const size = bitCount(v < 0 ? -v : v);
        sink.symbol((run << 4) | size);
        sink.bits(magnitudeBits(v, size), size);
        run = 0;
      }

      if (run > 0) {
        // Band ends with zeros: this block joins the end-of-block run.
        if (++eobrun === EOBRUN_MAX) {
          emitEobrun(sink, eobrun);
          eobrun = 0;
        }
      }
    }
  }

  if (eobrun > 0) emitEobrun(sink, eobrun);
}

function emitEobrun(sink, eobrun) {
  let temp = eobrun;
  let nbits = 0;
  while (temp > 1) {
    temp >>= 1;
    nbits++;
  }
  sink.symbol(nbits << 4); // run = nbits, size = 0
  if (nbits > 0) sink.bits(eobrun & ((1 << nbits) - 1), nbits);
}
