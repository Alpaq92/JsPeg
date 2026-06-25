// Per-component state used during encoding. Port of JpegHuffmanEncodingComponent.cs.
export class JpegHuffmanEncodingComponent {
  constructor() {
    this.index = 0;
    this.componentIndex = 0;
    this.horizontalSamplingFactor = 0;
    this.verticalSamplingFactor = 0;
    this.dcPredictor = 0;
    this.dcTableIdentifier = 0;
    this.acTableIdentifier = 0;
    this.dcTable = null;
    this.acTable = null;
    this.dcTableBuilder = null;
    this.acTableBuilder = null;
    this.quantizationTable = null;
    this.horizontalSubsamplingFactor = 0;
    this.verticalSubsamplingFactor = 0;
  }
}
