// Scan-decoder factory. Port of JpegScanDecoder.Create.
import { JpegMarker } from '../JpegMarker.js';
import { JpegHuffmanBaselineScanDecoder } from './JpegHuffmanBaselineScanDecoder.js';
import { JpegHuffmanProgressiveScanDecoder } from './JpegHuffmanProgressiveScanDecoder.js';
import { JpegHuffmanLosslessScanDecoder } from './JpegHuffmanLosslessScanDecoder.js';
import { JpegArithmeticSequentialScanDecoder } from './JpegArithmeticSequentialScanDecoder.js';
import { JpegArithmeticProgressiveScanDecoder } from './JpegArithmeticProgressiveScanDecoder.js';

/**
 * Create a scan decoder for the given Start-of-Frame marker.
 * @returns {object|null} a decoder with processScan(reader, scanHeader) and dispose()
 */
export function createScanDecoder(sofMarker, decoder, frameHeader) {
  switch (sofMarker) {
    case JpegMarker.StartOfFrame0:
    case JpegMarker.StartOfFrame1:
      return new JpegHuffmanBaselineScanDecoder(decoder, frameHeader);
    case JpegMarker.StartOfFrame2:
      return new JpegHuffmanProgressiveScanDecoder(decoder, frameHeader);
    case JpegMarker.StartOfFrame3:
      return new JpegHuffmanLosslessScanDecoder(decoder, frameHeader);
    case JpegMarker.StartOfFrame9:
      return new JpegArithmeticSequentialScanDecoder(decoder, frameHeader);
    case JpegMarker.StartOfFrame10:
      return new JpegArithmeticProgressiveScanDecoder(decoder, frameHeader);
    default:
      return null;
  }
}
