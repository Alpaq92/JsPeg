// Arithmetic-coding conditioning table (from the DAC marker). Port of
// JpegArithmeticDecodingTable.cs.
export class JpegArithmeticDecodingTable {
  constructor(tableClass, identifier) {
    this.tableClass = tableClass & 0xff;
    this.identifier = identifier & 0xff;
    this.conditioningTableValue = 0;
    this.dcL = 0;
    this.dcU = 0;
    this.acKx = 0;
  }

  configure(conditioningTableValue) {
    this.conditioningTableValue = conditioningTableValue;
    if (this.tableClass === 0) {
      this.dcL = conditioningTableValue & 0x0f;
      this.dcU = conditioningTableValue >> 4;
      this.acKx = 0;
    } else {
      this.dcL = 0;
      this.dcU = 0;
      this.acKx = conditioningTableValue;
    }
  }

  /**
   * Parse one conditioning table from a DAC segment at `offset`.
   * @returns {{ value: JpegArithmeticDecodingTable, bytesConsumed: number } | null}
   */
  static parse(buffer, offset = 0) {
    if (buffer.length - offset < 1) return null;
    const tableClassAndIdentifier = buffer[offset];
    const tableClass = tableClassAndIdentifier >> 4;
    const identifier = tableClassAndIdentifier & 0xf;
    if (buffer.length - offset < 2) return null;
    const conditioningTableValue = buffer[offset + 1];
    if (tableClass === 1 && (conditioningTableValue < 1 || conditioningTableValue > 63)) {
      return null;
    }
    const table = new JpegArithmeticDecodingTable(tableClass, identifier);
    table.configure(conditioningTableValue);
    return { value: table, bytesConsumed: 2 };
  }
}
